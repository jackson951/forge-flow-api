import { NodeKind } from '../definition/definition.schema';

/**
 * How a handler's work interacts with the outside world. It decides what happens when a
 * step is found RUNNING after a crash (docs/backend/15-IDEMPOTENCY-AND-SIDE-EFFECT-SAFETY.md):
 * - none / idempotent: safe to run again
 * - non-idempotent: the outcome is uncertain, so the step fails instead of repeating it
 */
export type SideEffect = 'none' | 'idempotent' | 'non-idempotent';

export interface NodeLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface NodeExecutionContext<C = Record<string, unknown>> {
  runId: string;
  workspaceId: string;
  nodeKey: string;
  /** Config after value resolution (Part 11). */
  config: C;
  /** Trigger payload as stored on the run. */
  triggerInput: unknown;
  /** Outputs of already executed steps, by node key. */
  outputs: Readonly<Record<string, unknown>>;
  /** Stable per (run, node): pass to providers that support idempotency keys. */
  idempotencyKey: string;
  /** 1-based attempt number of this step. */
  attempt: number;
  /** Aborted on timeout. Handlers must pass it to outbound calls. */
  signal: AbortSignal;
  logger: NodeLogger;
}

export interface NodeResult<O = unknown> {
  output: O;
  /** Provider-side id of the side effect (e.g. Slack message ts), kept on the StepRun. */
  externalRef?: string;
}

/**
 * Executes one node type. Handlers never get database access or other tenants' data:
 * everything they need is in the context (credentials arrive via a scoped accessor in
 * Part 17). Conditions return `{ output: { result: boolean } }`.
 */
export interface NodeHandler<C = Record<string, unknown>, O = unknown> {
  readonly type: string;
  readonly kind: NodeKind;
  readonly sideEffect: SideEffect;
  execute(context: NodeExecutionContext<C>): Promise<NodeResult<O>>;
}

export const NODE_HANDLERS = Symbol('NODE_HANDLERS');
