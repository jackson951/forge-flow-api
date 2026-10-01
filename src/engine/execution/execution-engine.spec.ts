import { ErrorCategory } from '@prisma/client';
import { EdgeDefinition, NodeDefinition } from '../definition/definition.schema';
import { PermanentError, RetryableError } from '../errors';
import { BUILT_IN_HANDLERS } from './built-in-handlers';
import { ExecutionEngine, identityResolver, ValueResolver } from './execution-engine';
import { NodeHandlerRegistry } from './handler-registry';
import { NodeHandler, SideEffect } from './node-handler';
import { InMemoryRunStore } from './testing/in-memory-run-store';
import { IllegalTransitionError } from './transitions';

const RUN = 'run-1';
const trigger: NodeDefinition = {
  key: 'trigger',
  kind: 'TRIGGER',
  type: 'manual.trigger',
  config: {},
};
const node = (
  key: string,
  type = 'rec',
  kind: NodeDefinition['kind'] = 'ACTION',
): NodeDefinition => ({
  key,
  kind,
  type,
  config: { key },
});
const edge = (from: string, to: string, branch?: 'true' | 'false'): EdgeDefinition =>
  branch ? { from, to, branch } : { from, to };

/** Records execution order; behaviour per node key can be overridden. */
function setup(
  nodes: NodeDefinition[],
  edges: EdgeDefinition[],
  opts: {
    behave?: Record<string, () => Promise<unknown>>;
    sideEffect?: SideEffect;
    timeoutMs?: number;
    maxOutputBytes?: number;
    resolver?: ValueResolver;
    triggerInput?: unknown;
  } = {},
) {
  const calls: string[] = [];
  const recorder: NodeHandler = {
    type: 'rec',
    kind: 'ACTION',
    sideEffect: opts.sideEffect ?? 'none',
    execute: async ({ nodeKey, outputs }) => {
      calls.push(nodeKey);
      const behave = opts.behave?.[nodeKey];
      return { output: behave ? await behave() : { from: nodeKey, seen: Object.keys(outputs) } };
    },
  };
  const branch = (result: unknown): NodeHandler => ({
    type: `branch.${String(result)}`,
    kind: 'CONDITION',
    sideEffect: 'none',
    execute: async ({ nodeKey }) => {
      calls.push(nodeKey);
      return { output: { result } };
    },
  });
  const registry = new NodeHandlerRegistry([
    ...BUILT_IN_HANDLERS,
    recorder,
    branch(true),
    branch(false),
    branch('yes'),
  ]);
  const store = new InMemoryRunStore({
    id: RUN,
    workspaceId: 'ws-1',
    status: 'RUNNING',
    triggerInput: opts.triggerInput ?? { issue: 1 },
    definition: { schemaVersion: 1, nodes: [trigger, ...nodes], edges },
  });
  const engine = new ExecutionEngine(store, registry, opts.resolver ?? identityResolver, {
    nodeTimeoutMs: opts.timeoutMs ?? 1_000,
    maxOutputBytes: opts.maxOutputBytes,
  });
  return { engine, store, calls };
}

const linear = () => [edge('trigger', 'a'), edge('a', 'b'), edge('b', 'c')];
const lastAttempt = { isFinalAttempt: true };
const notLast = { isFinalAttempt: false };

describe('ExecutionEngine', () => {
  describe('ordering and success', () => {
    it('executes a linear workflow in order and plans every step', async () => {
      const { engine, store, calls } = setup([node('a'), node('b'), node('c')], linear());
      await expect(engine.execute(RUN, lastAttempt)).resolves.toEqual({ status: 'SUCCEEDED' });
      expect(calls).toEqual(['a', 'b', 'c']);
      expect([...store.steps.values()].map((s) => [s.sequence, s.nodeKey, s.status])).toEqual([
        [1, 'trigger', 'SUCCEEDED'],
        [2, 'a', 'SUCCEEDED'],
        [3, 'b', 'SUCCEEDED'],
        [4, 'c', 'SUCCEEDED'],
      ]);
    });

    it('runs fan-out depth-first in edge order', async () => {
      const { engine, calls } = setup(
        [node('a'), node('a1'), node('b'), node('b1')],
        [edge('trigger', 'a'), edge('trigger', 'b'), edge('a', 'a1'), edge('b', 'b1')],
      );
      await engine.execute(RUN, lastAttempt);
      expect(calls).toEqual(['a', 'a1', 'b', 'b1']);
    });

    it('gives each step the outputs of earlier steps and the trigger input', async () => {
      const { engine, store } = setup(
        [node('a'), node('b')],
        [edge('trigger', 'a'), edge('a', 'b')],
        {
          triggerInput: { issue: 42 },
        },
      );
      await engine.execute(RUN, lastAttempt);
      expect(store.steps.get('trigger')?.output).toEqual({ issue: 42 });
      expect(store.steps.get('b')?.output).toEqual({ from: 'b', seen: ['trigger', 'a'] });
    });

    it('records the resolved config as the step input', async () => {
      const resolver: ValueResolver = { resolve: (config) => ({ ...config, resolved: true }) };
      const { engine, store } = setup([node('a')], [edge('trigger', 'a')], { resolver });
      await engine.execute(RUN, lastAttempt);
      expect(store.steps.get('a')?.input).toEqual({ key: 'a', resolved: true });
    });

    it('redacts credential-like keys in stored outputs', async () => {
      const { engine, store } = setup([node('a')], [edge('trigger', 'a')], {
        behave: { a: async () => ({ accessToken: 'xoxb-secret', ok: true }) },
      });
      await engine.execute(RUN, lastAttempt);
      expect(store.steps.get('a')?.output).toEqual({ accessToken: '[REDACTED]', ok: true });
    });
  });

  describe('conditions', () => {
    const tree = (result: 'true' | 'false') => ({
      nodes: [
        node('check', `branch.${result}`, 'CONDITION'),
        node('yes'),
        node('yes2'),
        node('no'),
      ],
      edges: [
        edge('trigger', 'check'),
        edge('check', 'yes', 'true'),
        edge('yes', 'yes2'),
        edge('check', 'no', 'false'),
      ],
    });

    it.each([
      ['true', ['check', 'yes', 'yes2'], { yes: 'SUCCEEDED', yes2: 'SUCCEEDED', no: 'SKIPPED' }],
      ['false', ['check', 'no'], { yes: 'SKIPPED', yes2: 'SKIPPED', no: 'SUCCEEDED' }],
    ] as const)('result %s runs only that branch', async (result, expectedCalls, states) => {
      const { nodes, edges } = tree(result);
      const { engine, store, calls } = setup(nodes, edges);
      await engine.execute(RUN, lastAttempt);
      expect(calls).toEqual(expectedCalls);
      expect(store.states()).toMatchObject(states);
    });

    it('a condition without a matching edge simply ends that path', async () => {
      const { engine, store } = setup(
        [node('check', 'branch.false', 'CONDITION'), node('yes')],
        [edge('trigger', 'check'), edge('check', 'yes', 'true')],
      );
      await expect(engine.execute(RUN, lastAttempt)).resolves.toEqual({ status: 'SUCCEEDED' });
      expect(store.states().yes).toBe('SKIPPED');
    });

    it('rejects a condition handler that does not return a boolean', async () => {
      const { engine, store } = setup(
        [node('check', 'branch.yes', 'CONDITION')],
        [edge('trigger', 'check')],
      );
      await expect(engine.execute(RUN, lastAttempt)).rejects.toMatchObject({
        category: ErrorCategory.INTERNAL,
      });
      expect(store.states().check).toBe('FAILED');
    });
  });

  describe('failures', () => {
    it('a permanent failure fails the step and skips everything after it', async () => {
      const { engine, store, calls } = setup([node('a'), node('b'), node('c')], linear(), {
        behave: {
          b: () =>
            Promise.reject(new PermanentError(ErrorCategory.PERMANENT_PROVIDER_ERROR, 'nope')),
        },
      });
      await expect(engine.execute(RUN, notLast)).rejects.toBeInstanceOf(PermanentError);
      expect(calls).toEqual(['a', 'b']);
      expect(store.states()).toEqual({
        trigger: 'SUCCEEDED',
        a: 'SUCCEEDED',
        b: 'FAILED',
        c: 'SKIPPED',
      });
      expect(store.steps.get('b')).toMatchObject({
        errorCategory: 'PERMANENT_PROVIDER_ERROR',
        errorMessage: 'nope',
      });
    });

    it('a retryable failure with attempts left marks the step RETRYING and leaves the rest PENDING', async () => {
      const { engine, store } = setup(
        [node('a'), node('b')],
        [edge('trigger', 'a'), edge('a', 'b')],
        {
          behave: {
            a: () =>
              Promise.reject(new RetryableError(ErrorCategory.PROVIDER_RATE_LIMIT, 'slow down')),
          },
        },
      );
      await expect(engine.execute(RUN, notLast)).rejects.toBeInstanceOf(RetryableError);
      expect(store.states()).toEqual({ trigger: 'SUCCEEDED', a: 'RETRYING', b: 'PENDING' });
    });

    it('the same failure on the final attempt is terminal', async () => {
      const { engine, store } = setup(
        [node('a'), node('b')],
        [edge('trigger', 'a'), edge('a', 'b')],
        {
          behave: {
            a: () =>
              Promise.reject(new RetryableError(ErrorCategory.PROVIDER_RATE_LIMIT, 'slow down')),
          },
        },
      );
      await expect(engine.execute(RUN, lastAttempt)).rejects.toBeInstanceOf(RetryableError);
      expect(store.states()).toEqual({ trigger: 'SUCCEEDED', a: 'FAILED', b: 'SKIPPED' });
    });

    it('unknown errors are INTERNAL and not retried; their messages are not stored', async () => {
      const { engine, store } = setup([node('a')], [edge('trigger', 'a')], {
        behave: { a: () => Promise.reject(new Error('db password=hunter2 leaked in message')) },
      });
      await expect(engine.execute(RUN, notLast)).rejects.toMatchObject({
        category: ErrorCategory.INTERNAL,
        retryable: false,
      });
      expect(store.steps.get('a')).toMatchObject({
        status: 'FAILED',
        errorMessage: 'Internal error',
      });
    });

    it('times out a hanging idempotent step as retryable PROVIDER_TIMEOUT', async () => {
      const { engine, store } = setup([node('a')], [edge('trigger', 'a')], {
        timeoutMs: 50,
        sideEffect: 'idempotent',
        behave: { a: () => new Promise(() => undefined) },
      });
      await expect(engine.execute(RUN, notLast)).rejects.toMatchObject({
        category: ErrorCategory.PROVIDER_TIMEOUT,
        retryable: true,
      });
      expect(store.states().a).toBe('RETRYING');
    });

    it('a timeout of a non-idempotent step is an uncertain outcome, never retried', async () => {
      const { engine, store } = setup([node('a')], [edge('trigger', 'a')], {
        timeoutMs: 50,
        sideEffect: 'non-idempotent',
        behave: { a: () => new Promise(() => undefined) },
      });
      await expect(engine.execute(RUN, notLast)).rejects.toMatchObject({
        category: ErrorCategory.UNCERTAIN_OUTCOME,
        retryable: false,
      });
      expect(store.states().a).toBe('FAILED');
    });

    it('rejects outputs over the size limit', async () => {
      const { engine, store } = setup([node('a')], [edge('trigger', 'a')], {
        maxOutputBytes: 100,
        behave: { a: async () => ({ blob: 'x'.repeat(200) }) },
      });
      await expect(engine.execute(RUN, lastAttempt)).rejects.toMatchObject({
        category: ErrorCategory.VALIDATION,
      });
      expect(store.states().a).toBe('FAILED');
    });

    it('fails clearly when a node type has no handler', async () => {
      const { engine, store } = setup([node('a', 'missing.type')], [edge('trigger', 'a')]);
      await expect(engine.execute(RUN, lastAttempt)).rejects.toMatchObject({
        message: 'No handler for node type "missing.type"',
      });
      expect(store.states().a).toBe('FAILED');
    });

    it('a resolver error fails the step without running the handler', async () => {
      const resolver: ValueResolver = {
        resolve: (config) => {
          if (config.key !== 'a') return config;
          throw new PermanentError(ErrorCategory.VALIDATION, 'bad reference');
        },
      };
      const { engine, store, calls } = setup([node('a')], [edge('trigger', 'a')], { resolver });
      await expect(engine.execute(RUN, lastAttempt)).rejects.toMatchObject({
        message: 'bad reference',
      });
      expect(calls).toEqual([]);
      expect(store.steps.get('a')).toMatchObject({ status: 'FAILED', errorCategory: 'VALIDATION' });
    });
  });

  describe('resume after retry or crash (AC-08.6)', () => {
    it('does not re-execute succeeded steps and reuses their stored outputs', async () => {
      let failB = true;
      const { engine, store, calls } = setup([node('a'), node('b'), node('c')], linear(), {
        behave: {
          b: async () => {
            if (failB) {
              failB = false;
              throw new RetryableError(ErrorCategory.PROVIDER_TIMEOUT, 'flaky');
            }
            return { from: 'b' };
          },
        },
      });
      await expect(engine.execute(RUN, notLast)).rejects.toBeInstanceOf(RetryableError);
      await expect(engine.execute(RUN, lastAttempt)).resolves.toEqual({ status: 'SUCCEEDED' });

      expect(calls).toEqual(['a', 'b', 'b', 'c']);
      expect(store.steps.get('a')?.attemptCount).toBe(1);
      expect(store.steps.get('b')?.attemptCount).toBe(2);
      expect(store.steps.get('c')?.output).toEqual({ from: 'c', seen: ['trigger', 'a', 'b'] });
    });

    it('re-executes an idempotent step that was left RUNNING by a crash', async () => {
      const { engine, store, calls } = setup([node('a')], [edge('trigger', 'a')], {
        sideEffect: 'idempotent',
      });
      await store.planSteps(RUN, [
        { nodeKey: 'trigger', nodeType: 'manual.trigger', sequence: 1 },
        { nodeKey: 'a', nodeType: 'rec', sequence: 2 },
      ]);
      await store.startStep(RUN, 'a', {}); // the crashed attempt
      await expect(engine.execute(RUN, lastAttempt)).resolves.toEqual({ status: 'SUCCEEDED' });
      expect(calls).toEqual(['a']);
      expect(store.steps.get('a')).toMatchObject({ status: 'SUCCEEDED', attemptCount: 2 });
    });

    it('does NOT repeat a non-idempotent step left RUNNING: UNCERTAIN_OUTCOME', async () => {
      const { engine, store, calls } = setup(
        [node('a'), node('b')],
        [edge('trigger', 'a'), edge('a', 'b')],
        {
          sideEffect: 'non-idempotent',
        },
      );
      await store.planSteps(RUN, [
        { nodeKey: 'trigger', nodeType: 'manual.trigger', sequence: 1 },
        { nodeKey: 'a', nodeType: 'rec', sequence: 2 },
        { nodeKey: 'b', nodeType: 'rec', sequence: 3 },
      ]);
      await store.startStep(RUN, 'a', {});
      await expect(engine.execute(RUN, notLast)).rejects.toMatchObject({
        category: ErrorCategory.UNCERTAIN_OUTCOME,
        retryable: false,
      });
      expect(calls).toEqual([]);
      expect(store.states()).toMatchObject({ a: 'FAILED', b: 'SKIPPED' });
    });
  });

  describe('cancellation', () => {
    it('stops before the next step and skips the rest', async () => {
      const { engine, store, calls } = setup([node('a'), node('b'), node('c')], linear(), {
        behave: {
          a: async () => {
            store.cancelRequested = true;
            return {};
          },
        },
      });
      await expect(engine.execute(RUN, lastAttempt)).resolves.toEqual({ status: 'CANCELLED' });
      expect(calls).toEqual(['a']);
      expect(store.states()).toEqual({
        trigger: 'SUCCEEDED',
        a: 'SUCCEEDED',
        b: 'SKIPPED',
        c: 'SKIPPED',
      });
    });
  });

  it('a version that is not a valid definition fails permanently', async () => {
    const store = new InMemoryRunStore({
      id: RUN,
      workspaceId: 'ws',
      status: 'RUNNING',
      triggerInput: {},
      definition: { schemaVersion: 99 },
    });
    const engine = new ExecutionEngine(store, new NodeHandlerRegistry(), identityResolver, {
      nodeTimeoutMs: 100,
    });
    await expect(engine.execute(RUN, lastAttempt)).rejects.toMatchObject({
      category: 'VALIDATION',
    });
  });
});

describe('InMemoryRunStore transitions', () => {
  it('rejects illegal step transitions like the database store', async () => {
    const store = new InMemoryRunStore({
      id: RUN,
      workspaceId: 'ws',
      status: 'RUNNING',
      triggerInput: {},
      definition: {},
    });
    await store.planSteps(RUN, [{ nodeKey: 'a', nodeType: 'rec', sequence: 1 }]);
    await expect(store.completeStep(RUN, 'a', { sanitizedOutput: {} })).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });
});
