import { ErrorCategory } from '@prisma/client';
import {
  NodeDefinition,
  parseDefinition,
  WorkflowDefinition,
} from '../definition/definition.schema';
import {
  classifyError,
  ExecutionError,
  OwnershipLostError,
  PermanentError,
  RetryableError,
} from '../errors';
import { NodeHandlerRegistry } from './handler-registry';
import { NodeHandler, NodeLogger, NodeResult } from './node-handler';
import { RunSnapshot, RunStore, StepSnapshot } from './run-store';
import { IllegalTransitionError } from './transitions';
import { jsonByteLength, sanitizeForStorage, toPlainJson } from './sanitize';

/** Turns a node's stored config into the config the handler receives (data mapping). */
export interface ValueResolver {
  resolve(
    config: Record<string, unknown>,
    scope: { triggerInput: unknown; outputs: Readonly<Record<string, unknown>> },
    node: Pick<NodeDefinition, 'key' | 'kind' | 'type'>,
  ): Record<string, unknown>;
}

/** Configs used exactly as written (unit tests). */
export const identityResolver: ValueResolver = { resolve: (config) => config };

export interface EngineOptions {
  nodeTimeoutMs: number;
  maxOutputBytes?: number;
  log?: (level: 'info' | 'warn', message: string, fields: Record<string, unknown>) => void;
}

export interface AttemptInfo {
  /** No further job retry will follow: retryable failures become final. */
  isFinalAttempt: boolean;
  /** Fencing token of the worker's run claim, passed to fenced store writes. */
  claim?: string;
  /** Run-level log context (correlationId, workspaceId, jobId, ...) added to every log line. */
  logFields?: Record<string, unknown>;
}

export type EngineOutcome = { status: 'SUCCEEDED' } | { status: 'CANCELLED' };

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Executes an immutable workflow version (docs/backend/08-WORKFLOW-EXECUTION-ENGINE.md).
 *
 * - Order: depth-first from the trigger, children in edge order (deterministic).
 * - Every node is planned as a PENDING StepRun up front; nodes on branches not taken, and
 *   nodes after a terminal failure, end as SKIPPED.
 * - Resume: on a job retry or redelivery, SUCCEEDED steps are not executed again; their
 *   stored outputs are reused. A step found RUNNING (the previous worker died mid-step) is
 *   re-executed only if its handler has no non-idempotent side effect; otherwise it fails
 *   with UNCERTAIN_OUTCOME rather than risk doing the side effect twice.
 * - Errors: the step is marked RETRYING (job will retry, then resume here) or FAILED
 *   (permanent, or retries exhausted), and a classified ExecutionError is thrown. Run-level
 *   status is the caller's job (RunWorkerService).
 *
 * Pure orchestration: no Nest, no Prisma, no provider SDKs.
 */
export class ExecutionEngine {
  private readonly maxOutputBytes: number;

  constructor(
    private readonly store: RunStore,
    private readonly handlers: NodeHandlerRegistry,
    private readonly resolver: ValueResolver,
    private readonly options: EngineOptions,
  ) {
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async execute(runId: string, attempt: AttemptInfo): Promise<EngineOutcome> {
    const run = await this.store.loadRun(runId);
    if (!run) throw new PermanentError(ErrorCategory.INTERNAL, 'Run not found');

    const parsed = parseDefinition(run.definition);
    if (!parsed.ok) {
      throw new PermanentError(
        ErrorCategory.VALIDATION,
        'Workflow version is not a valid definition',
      );
    }
    const graph = buildGraph(parsed.definition);

    await this.store.planSteps(
      runId,
      graph.order.map((node, i) => ({ nodeKey: node.key, nodeType: node.type, sequence: i + 1 })),
    );
    const steps = await this.store.loadSteps(runId);
    const outputs: Record<string, unknown> = {};

    const stack: NodeDefinition[] = [graph.trigger];
    while (stack.length) {
      const node = stack.pop()!;
      if (await this.store.isCancelRequested(runId)) {
        await this.store.skipRemaining(runId, attempt.claim);
        return { status: 'CANCELLED' };
      }

      const output = await this.runNode(run, node, steps.get(node.key), outputs, attempt);
      outputs[node.key] = output;

      const next = graph
        .children(node.key)
        .filter(
          (edge) =>
            node.kind !== 'CONDITION' ||
            edge.branch === String((output as { result: boolean }).result),
        );
      // Reverse so the first edge in the definition is executed first.
      for (const edge of [...next].reverse()) stack.push(graph.node(edge.to));
    }

    await this.store.skipRemaining(runId, attempt.claim);
    return { status: 'SUCCEEDED' };
  }

  private async runNode(
    run: RunSnapshot,
    node: NodeDefinition,
    existing: StepSnapshot | undefined,
    outputs: Record<string, unknown>,
    attempt: AttemptInfo,
  ): Promise<unknown> {
    if (existing?.status === 'SUCCEEDED') return existing.output;

    const handler = this.handlers.get(node.type);
    if (!handler) {
      return this.fail(
        run.id,
        node,
        attempt,
        0,
        new PermanentError(ErrorCategory.VALIDATION, `No handler for node type "${node.type}"`),
      );
    }

    if (existing?.status === 'RUNNING' && handler.sideEffect === 'non-idempotent') {
      return this.fail(
        run.id,
        node,
        attempt,
        0,
        new PermanentError(
          ErrorCategory.UNCERTAIN_OUTCOME,
          'The previous attempt stopped while this step was running; it may or may not have completed, so it is not repeated automatically',
        ),
      );
    }

    let config: Record<string, unknown>;
    try {
      config = this.resolver.resolve(
        node.config,
        { triggerInput: run.triggerInput, outputs },
        node,
      );
    } catch (err) {
      return this.fail(run.id, node, attempt, 0, err);
    }

    // The RUNNING marker is persisted before the handler runs (fenced: a worker that lost the
    // run never starts a step).
    let stepAttempt: number;
    try {
      stepAttempt = await this.store.startStep(
        run.id,
        node.key,
        sanitizeForStorage(config),
        attempt.claim,
      );
    } catch (startErr) {
      const done = await this.recordedSuccess(run.id, node.key, startErr);
      return done.output;
    }
    const started = Date.now();
    this.log(attempt, 'info', 'Step started', {
      runId: run.id,
      nodeKey: node.key,
      nodeType: node.type,
      stepAttempt,
    });
    try {
      const result = await this.invoke(handler, {
        runId: run.id,
        workspaceId: run.workspaceId,
        nodeKey: node.key,
        config,
        triggerInput: run.triggerInput,
        outputs,
        idempotencyKey: `${run.id}:${node.key}`,
        attempt: stepAttempt,
        logger: this.nodeLogger(run.id, node.key, attempt),
      });

      const output = toPlainJson(result.output);
      if (jsonByteLength(output) > this.maxOutputBytes) {
        throw new PermanentError(
          ErrorCategory.VALIDATION,
          `Step output exceeds ${this.maxOutputBytes / 1024} KB`,
        );
      }
      if (
        node.kind === 'CONDITION' &&
        typeof (output as { result?: unknown })?.result !== 'boolean'
      ) {
        throw new PermanentError(
          ErrorCategory.INTERNAL,
          'Condition handler must return { result: boolean }',
        );
      }

      try {
        await this.store.completeStep(run.id, node.key, {
          sanitizedOutput: sanitizeForStorage(output),
          durationMs: Date.now() - started,
          externalRef: result.externalRef,
        });
      } catch (completeErr) {
        return (await this.recordedSuccess(run.id, node.key, completeErr)).output;
      }
      this.log(attempt, 'info', 'Step succeeded', {
        runId: run.id,
        nodeKey: node.key,
        attempt: stepAttempt,
        durationMs: Date.now() - started,
      });
      return output;
    } catch (err) {
      return this.fail(run.id, node, attempt, Date.now() - started, err);
    }
  }

  /** Runs the handler under a timeout. Timeouts of non-idempotent steps are uncertain. */
  private async invoke(
    handler: NodeHandler,
    context: Omit<Parameters<NodeHandler['execute']>[0], 'signal'>,
  ): Promise<NodeResult> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          handler.sideEffect === 'non-idempotent'
            ? new PermanentError(
                ErrorCategory.UNCERTAIN_OUTCOME,
                `Step timed out after ${this.options.nodeTimeoutMs} ms; it may have completed, so it is not retried automatically`,
              )
            : new RetryableError(
                ErrorCategory.PROVIDER_TIMEOUT,
                `Step timed out after ${this.options.nodeTimeoutMs} ms`,
              ),
        );
      }, this.options.nodeTimeoutMs);
    });
    try {
      return await Promise.race([
        handler.execute({ ...context, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * After a stalled job is redelivered, the original worker may still finish a step it was
   * running. If a step write is refused because the step is already SUCCEEDED, the other
   * worker recorded it first and its stored result counts. Any other refusal is rethrown.
   */
  private async recordedSuccess(
    runId: string,
    nodeKey: string,
    err: unknown,
  ): Promise<StepSnapshot> {
    if (!(err instanceof IllegalTransitionError)) throw err;
    const current = (await this.store.loadSteps(runId)).get(nodeKey);
    if (current?.status !== 'SUCCEEDED') throw err;
    return current;
  }

  /** Records the failure on the step and throws a classified error. */
  private async fail(
    runId: string,
    node: NodeDefinition,
    attempt: AttemptInfo,
    durationMs: number,
    err: unknown,
  ): Promise<never> {
    const classified = classifyError(err);
    const final = !classified.retryable || attempt.isFinalAttempt;
    // Each write is independent and best effort: the store itself may be what failed
    // (database down). The original error wins; a retried job finds the step RUNNING and
    // resumes according to the side-effect rule. Losing the run to another worker is the
    // exception: then this worker stops immediately.
    const bestEffort = (write: Promise<void>) =>
      write.catch((writeErr: unknown) => {
        if (writeErr instanceof OwnershipLostError) throw writeErr;
      });
    await bestEffort(
      this.store.failStep(
        runId,
        node.key,
        {
          status: final ? 'FAILED' : 'RETRYING',
          category: classified.category,
          message: classified.message,
          durationMs,
        },
        attempt.claim,
      ),
    );
    if (final) await bestEffort(this.store.skipRemaining(runId, attempt.claim));
    this.log(attempt, 'warn', 'Step failed', {
      runId,
      nodeKey: node.key,
      errorCategory: classified.category,
      retryable: classified.retryable,
      final,
    });
    if (err instanceof ExecutionError) throw err;
    throw classified.retryable
      ? new RetryableError(classified.category, classified.message, classified.retryAfterMs)
      : new PermanentError(classified.category, classified.message);
  }

  private log(
    attempt: AttemptInfo,
    level: 'info' | 'warn',
    message: string,
    fields: Record<string, unknown>,
  ): void {
    this.options.log?.(level, message, { ...attempt.logFields, ...fields });
  }

  private nodeLogger(runId: string, nodeKey: string, attempt: AttemptInfo): NodeLogger {
    return {
      info: (message, fields) => this.log(attempt, 'info', message, { ...fields, runId, nodeKey }),
      warn: (message, fields) => this.log(attempt, 'warn', message, { ...fields, runId, nodeKey }),
    };
  }
}

interface Graph {
  trigger: NodeDefinition;
  order: NodeDefinition[];
  node(key: string): NodeDefinition;
  children(key: string): { to: string; branch?: string }[];
}

/** Indexes a validated definition (one trigger, tree-shaped) and computes the DFS order. */
function buildGraph(definition: WorkflowDefinition): Graph {
  const nodes = new Map(definition.nodes.map((n) => [n.key, n]));
  const edges = new Map<string, { to: string; branch?: string }[]>();
  for (const e of definition.edges) edges.set(e.from, [...(edges.get(e.from) ?? []), e]);

  const trigger = definition.nodes.find((n) => n.kind === 'TRIGGER');
  if (!trigger)
    throw new PermanentError(ErrorCategory.VALIDATION, 'Workflow version has no trigger');

  const order: NodeDefinition[] = [];
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    order.push(nodes.get(key)!);
    for (const edge of edges.get(key) ?? []) visit(edge.to);
  };
  visit(trigger.key);

  return {
    trigger,
    order,
    node: (key) => nodes.get(key)!,
    children: (key) => edges.get(key) ?? [],
  };
}
