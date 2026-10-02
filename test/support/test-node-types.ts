import { ErrorCategory } from '@prisma/client';
import { z } from 'zod';
import { NodeTypeCatalog, NodeTypeDefinition } from '../../src/engine/catalog/node-type-catalog';
import { PermanentError, RetryableError } from '../../src/engine/errors';
import { NodeHandlerRegistry } from '../../src/engine/execution/handler-registry';
import { NodeHandler } from '../../src/engine/execution/node-handler';

/**
 * Test-only node types that make every engine/queue behaviour reproducible on demand.
 * Register them in both the API app (catalog, for validation) and the worker (catalog +
 * handlers).
 */
export class TestNodeControl {
  /** test.flaky failures per run so far. */
  readonly flakyFailures = new Map<string, number>();
  /** test.sideEffect calls, in order. */
  readonly sideEffects: string[] = [];
  private gate?: { promise: Promise<void>; release: () => void; entered: () => void };
  private enteredPromise?: Promise<void>;

  /** Makes the next test.wait steps block until `release()`. */
  hold(): { entered: Promise<void>; release: () => void } {
    let release!: () => void;
    let entered!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    this.enteredPromise = new Promise<void>((r) => (entered = r));
    this.gate = { promise, release, entered };
    return { entered: this.enteredPromise, release };
  }

  async waitAtGate(): Promise<void> {
    if (!this.gate) return;
    this.gate.entered();
    await this.gate.promise;
  }
}

const empty = z.object({}).strict();

const types: NodeTypeDefinition[] = [
  {
    type: 'test.flaky',
    kind: 'ACTION',
    displayName: 'Fails N times (retryable)',
    configSchema: z.object({ failTimes: z.number().int().min(0) }).strict(),
  },
  {
    type: 'test.fail',
    kind: 'ACTION',
    displayName: 'Always fails',
    configSchema: z.object({ mode: z.enum(['permanent', 'retryable']) }).strict(),
  },
  { type: 'test.wait', kind: 'ACTION', displayName: 'Waits at the gate', configSchema: empty },
  {
    type: 'test.branch',
    kind: 'CONDITION',
    displayName: 'Fixed condition',
    configSchema: z.object({ result: z.boolean() }).strict(),
  },
  {
    type: 'test.echo',
    kind: 'ACTION',
    displayName: 'Echoes previous outputs',
    configSchema: empty,
  },
  {
    // Webhook trigger for the non-production TEST provider (Part 09).
    type: 'test.event',
    kind: 'TRIGGER',
    displayName: 'Test webhook event',
    configSchema: z.object({ event: z.string().min(1), resource: z.string().min(1) }).strict(),
    route: (config) => ({
      provider: 'TEST',
      eventType: String(config.event),
      resourceKey: String(config.resource),
    }),
  },
  {
    type: 'test.sideEffect',
    kind: 'ACTION',
    displayName: 'Records a non-idempotent call',
    configSchema: z.object({ label: z.string() }).strict(),
  },
];

export function testHandlers(control: TestNodeControl): NodeHandler[] {
  return [
    {
      type: 'test.event',
      kind: 'TRIGGER',
      sideEffect: 'none',
      execute: async ({ triggerInput }) => ({ output: triggerInput ?? {} }),
    },
    {
      type: 'test.flaky',
      kind: 'ACTION',
      sideEffect: 'idempotent',
      execute: async ({ runId, config }) => {
        const failed = control.flakyFailures.get(runId) ?? 0;
        if (failed < (config.failTimes as number)) {
          control.flakyFailures.set(runId, failed + 1);
          throw new RetryableError(ErrorCategory.PROVIDER_TIMEOUT, `flaky failure ${failed + 1}`);
        }
        return { output: { succeededAfter: failed } };
      },
    },
    {
      type: 'test.fail',
      kind: 'ACTION',
      sideEffect: 'none',
      execute: async ({ config }) => {
        if (config.mode === 'permanent') {
          throw new PermanentError(
            ErrorCategory.PERMANENT_PROVIDER_ERROR,
            'provider rejected the request',
          );
        }
        throw new RetryableError(ErrorCategory.TRANSIENT_INFRASTRUCTURE, 'still unavailable');
      },
    },
    {
      type: 'test.wait',
      kind: 'ACTION',
      sideEffect: 'none',
      execute: async () => {
        await control.waitAtGate();
        return { output: { waited: true } };
      },
    },
    {
      type: 'test.branch',
      kind: 'CONDITION',
      sideEffect: 'none',
      execute: async ({ config }) => ({ output: { result: config.result as boolean } }),
    },
    {
      type: 'test.echo',
      kind: 'ACTION',
      sideEffect: 'none',
      execute: async ({ outputs, triggerInput }) => ({ output: { triggerInput, outputs } }),
    },
    {
      type: 'test.sideEffect',
      kind: 'ACTION',
      sideEffect: 'non-idempotent',
      execute: async ({ config, idempotencyKey }) => {
        control.sideEffects.push(`${config.label as string}@${idempotencyKey}`);
        return { output: { sent: true }, externalRef: `ref-${control.sideEffects.length}` };
      },
    },
  ];
}

export function registerTestTypes(catalog: NodeTypeCatalog): void {
  types.forEach((t) => catalog.register(t));
}

export function registerTestHandlers(
  registry: NodeHandlerRegistry,
  control: TestNodeControl,
): void {
  testHandlers(control).forEach((h) => registry.register(h));
}
