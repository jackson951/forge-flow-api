import { NodeTypeCatalog } from '../catalog/node-type-catalog';
import {
  EdgeDefinition,
  NodeDefinition,
  parseDefinition,
  WorkflowDefinition,
} from '../definition/definition.schema';
import { hasErrors, IssueCode, validateDefinition, ValidationIssue } from './graph-validator';

const catalog = new NodeTypeCatalog();

const trigger = (key = 'trigger'): NodeDefinition => ({
  key,
  kind: 'TRIGGER',
  type: 'manual.trigger',
  config: {},
});
const log = (key: string, message = 'hi'): NodeDefinition => ({
  key,
  kind: 'ACTION',
  type: 'util.log',
  config: { message },
});
const condition = (key: string): NodeDefinition => ({
  key,
  kind: 'CONDITION',
  type: 'condition',
  config: {
    all: [{ left: { ref: 'trigger.priority' }, operator: 'equals', right: { value: 'HIGH' } }],
  },
});
const edge = (from: string, to: string, branch?: 'true' | 'false'): EdgeDefinition =>
  branch ? { from, to, branch } : { from, to };

const def = (nodes: NodeDefinition[], edges: EdgeDefinition[] = []): WorkflowDefinition => ({
  schemaVersion: 1,
  nodes,
  edges,
});

const validate = (d: WorkflowDefinition) => validateDefinition(d, catalog);
const codes = (issues: ValidationIssue[]) => issues.map((i) => i.code);
const only = (d: WorkflowDefinition, code: IssueCode) => validate(d).filter((i) => i.code === code);

describe('validateDefinition', () => {
  describe('valid workflows', () => {
    it('accepts a linear workflow', () => {
      const d = def([trigger(), log('a'), log('b')], [edge('trigger', 'a'), edge('a', 'b')]);
      expect(validate(d)).toEqual([]);
    });

    it('accepts a branching workflow with both branches and fan-out', () => {
      const d = def(
        [trigger(), condition('isHigh'), log('yes'), log('no'), log('alsoYes')],
        [
          edge('trigger', 'isHigh'),
          edge('isHigh', 'yes', 'true'),
          edge('isHigh', 'no', 'false'),
          edge('yes', 'alsoYes'),
        ],
      );
      expect(validate(d)).toEqual([]);
    });

    it('accepts a trigger-only workflow', () => {
      expect(validate(def([trigger()]))).toEqual([]);
    });
  });

  describe('triggers', () => {
    it('NO_TRIGGER', () => {
      expect(codes(validate(def([log('a')])))).toContain('NO_TRIGGER');
      expect(codes(validate(def([])))).toEqual(['NO_TRIGGER']);
    });

    it('MULTIPLE_TRIGGERS names the extra trigger', () => {
      expect(only(def([trigger('t1'), trigger('t2')]), 'MULTIPLE_TRIGGERS')).toEqual([
        expect.objectContaining({ nodeKey: 't2', severity: 'error' }),
      ]);
    });
  });

  describe('nodes', () => {
    it('DUPLICATE_NODE_KEY', () => {
      expect(
        only(def([trigger(), log('a'), log('a')], [edge('trigger', 'a')]), 'DUPLICATE_NODE_KEY'),
      ).toHaveLength(1);
    });

    it('UNKNOWN_NODE_TYPE for an unregistered type', () => {
      const d = def(
        [trigger(), { key: 'x', kind: 'ACTION', type: 'nope.action', config: {} }],
        [edge('trigger', 'x')],
      );
      expect(only(d, 'UNKNOWN_NODE_TYPE')).toEqual([
        expect.objectContaining({ nodeKey: 'x', message: 'Unknown node type "nope.action"' }),
      ]);
    });

    it('UNKNOWN_NODE_TYPE when the kind does not match the type', () => {
      const d = def([{ key: 't', kind: 'TRIGGER', type: 'util.log', config: { message: 'x' } }]);
      expect(only(d, 'UNKNOWN_NODE_TYPE')[0].message).toMatch(/is a ACTION node, not TRIGGER/);
    });

    it('INVALID_NODE_CONFIG with the failing path', () => {
      const d = def([trigger(), log('a', '')], [edge('trigger', 'a')]);
      expect(only(d, 'INVALID_NODE_CONFIG')).toEqual([
        expect.objectContaining({ nodeKey: 'a', path: 'message' }),
      ]);
    });

    it('INVALID_NODE_CONFIG for unknown config keys and bad condition shape', () => {
      const d = def(
        [
          trigger(),
          { key: 'a', kind: 'ACTION', type: 'util.log', config: { message: 'x', extra: 1 } },
          { key: 'c', kind: 'CONDITION', type: 'condition', config: { all: [] } },
        ],
        [edge('trigger', 'a'), edge('a', 'c')],
      );
      expect(
        only(d, 'INVALID_NODE_CONFIG')
          .map((i) => i.nodeKey)
          .sort(),
      ).toEqual(['a', 'c']);
    });

    it.each([
      'apiKey',
      'api_key',
      'token',
      'accessToken',
      'client_secret',
      'password',
      'privateKey',
    ])('SECRET_IN_CONFIG for "%s", reported with its path', (key) => {
      const d = def(
        [
          trigger(),
          {
            key: 'a',
            kind: 'ACTION',
            type: 'util.log',
            config: { message: 'x', nested: [{ [key]: 'v' }] },
          },
        ],
        [edge('trigger', 'a')],
      );
      expect(only(d, 'SECRET_IN_CONFIG')).toEqual([
        expect.objectContaining({ nodeKey: 'a', path: `nested.0.${key}` }),
      ]);
    });

    it.each(['maxTokens', 'connectionId', 'key', 'tokenizer', 'passwordPolicyUrl'])(
      'does not flag harmless key "%s"',
      (key) => {
        const d = def(
          [
            trigger(),
            { key: 'a', kind: 'ACTION', type: 'util.log', config: { message: 'x', [key]: 1 } },
          ],
          [edge('trigger', 'a')],
        );
        expect(only(d, 'SECRET_IN_CONFIG')).toEqual([]);
      },
    );
  });

  describe('edges', () => {
    it('EDGE_UNKNOWN_NODE (references to missing nodes)', () => {
      const d = def([trigger()], [edge('trigger', 'ghost')]);
      expect(only(d, 'EDGE_UNKNOWN_NODE')).toEqual([
        expect.objectContaining({ edge: { from: 'trigger', to: 'ghost', index: 0 } }),
      ]);
    });

    it('SELF_LOOP', () => {
      const d = def([trigger(), log('a')], [edge('trigger', 'a'), edge('a', 'a')]);
      expect(codes(validate(d))).toContain('SELF_LOOP');
    });

    it('DUPLICATE_EDGE', () => {
      const d = def([trigger(), log('a')], [edge('trigger', 'a'), edge('trigger', 'a')]);
      expect(only(d, 'DUPLICATE_EDGE')).toHaveLength(1);
      expect(only(d, 'MULTIPLE_INCOMING')).toHaveLength(0); // the duplicate is not double-counted
    });

    it('EDGE_INTO_TRIGGER', () => {
      const d = def([trigger(), log('a')], [edge('trigger', 'a'), edge('a', 'trigger')]);
      expect(codes(validate(d))).toContain('EDGE_INTO_TRIGGER');
    });

    it('BRANCH_REQUIRED on edges out of a condition', () => {
      const d = def([trigger(), condition('c'), log('a')], [edge('trigger', 'c'), edge('c', 'a')]);
      expect(codes(validate(d))).toContain('BRANCH_REQUIRED');
    });

    it('BRANCH_NOT_ALLOWED on other edges', () => {
      const d = def([trigger(), log('a')], [edge('trigger', 'a', 'true')]);
      expect(codes(validate(d))).toContain('BRANCH_NOT_ALLOWED');
    });

    it('DUPLICATE_BRANCH', () => {
      const d = def(
        [trigger(), condition('c'), log('a'), log('b')],
        [edge('trigger', 'c'), edge('c', 'a', 'true'), edge('c', 'b', 'true')],
      );
      expect(only(d, 'DUPLICATE_BRANCH')).toHaveLength(1);
    });
  });

  describe('graph shape', () => {
    it('MULTIPLE_INCOMING (joins are unsupported)', () => {
      const d = def(
        [trigger(), condition('c'), log('a'), log('b'), log('join')],
        [
          edge('trigger', 'c'),
          edge('c', 'a', 'true'),
          edge('c', 'b', 'false'),
          edge('a', 'join'),
          edge('b', 'join'),
        ],
      );
      expect(only(d, 'MULTIPLE_INCOMING')).toEqual([expect.objectContaining({ nodeKey: 'join' })]);
    });

    it('CYCLE (and the cycle is unreachable from the trigger)', () => {
      const d = def([trigger(), log('a'), log('b')], [edge('a', 'b'), edge('b', 'a')]);
      const issues = validate(d);
      expect(only(d, 'CYCLE')).toEqual([
        expect.objectContaining({ message: 'Cycle detected: a → b → a' }),
      ]);
      expect(issues.filter((i) => i.code === 'UNREACHABLE_NODE').map((i) => i.nodeKey)).toEqual([
        'a',
        'b',
      ]);
    });

    it('UNREACHABLE_NODE / disconnected nodes', () => {
      const d = def([trigger(), log('a'), log('island')], [edge('trigger', 'a')]);
      expect(only(d, 'UNREACHABLE_NODE')).toEqual([expect.objectContaining({ nodeKey: 'island' })]);
    });

    it('skips reachability when the trigger count is wrong (avoids noise)', () => {
      expect(codes(validate(def([log('a')])))).toEqual(['NO_TRIGGER']);
    });

    it('CONDITION_WITHOUT_BRANCH is a warning, not an error', () => {
      const d = def([trigger(), condition('c')], [edge('trigger', 'c')]);
      const issues = validate(d);
      expect(issues).toEqual([
        expect.objectContaining({ code: 'CONDITION_WITHOUT_BRANCH', severity: 'warning' }),
      ]);
      expect(hasErrors(issues)).toBe(false);
    });
  });

  describe('limits', () => {
    it('LIMIT_EXCEEDED for too many nodes and edges', () => {
      const nodes = [trigger(), ...Array.from({ length: 50 }, (_, i) => log(`n${i}`))];
      const edges = nodes.slice(1).map((n) => edge('trigger', n.key));
      const tooManyEdges = [
        ...edges,
        ...Array.from({ length: 51 }, (_, i) => edge(`n${i % 50}`, `x${i}`)),
      ];
      expect(only(def(nodes, edges), 'LIMIT_EXCEEDED')[0].message).toMatch(/50 nodes/);
      expect(only(def(nodes, tooManyEdges), 'LIMIT_EXCEEDED').map((i) => i.message)).toContain(
        'At most 100 edges',
      );
    });

    it('LIMIT_EXCEEDED for an oversized node config', () => {
      const d = def(
        [
          trigger(),
          {
            key: 'a',
            kind: 'ACTION',
            type: 'util.log',
            config: { message: 'x', blob: 'y'.repeat(17_000) },
          },
        ],
        [edge('trigger', 'a')],
      );
      expect(only(d, 'LIMIT_EXCEEDED')).toEqual([expect.objectContaining({ nodeKey: 'a' })]);
    });

    it('LIMIT_EXCEEDED for an oversized definition', () => {
      const big = Array.from({ length: 20 }, (_, i) => ({
        key: `n${i}`,
        kind: 'ACTION' as const,
        type: 'util.log',
        config: { message: 'x', blob: 'y'.repeat(15_000) },
      }));
      const d = def(
        [trigger(), ...big],
        big.map((n) => edge('trigger', n.key)),
      );
      expect(only(d, 'LIMIT_EXCEEDED').map((i) => i.message)).toContain(
        'Definition exceeds 256 KB',
      );
    });
  });

  it('is deterministic', () => {
    const d = def([trigger(), log('a'), log('a'), log('b')], [edge('x', 'y'), edge('a', 'a')]);
    expect(validate(d)).toEqual(validate(d));
  });
});

describe('parseDefinition', () => {
  it('accepts a valid shape and applies defaults', () => {
    const parsed = parseDefinition({
      schemaVersion: 1,
      nodes: [{ key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger' }],
      edges: [],
    });
    expect(parsed).toEqual({
      ok: true,
      definition: expect.objectContaining({ nodes: [expect.objectContaining({ config: {} })] }),
    });
  });

  it.each([
    ['wrong schemaVersion', { schemaVersion: 2, nodes: [], edges: [] }, 'schemaVersion'],
    ['missing edges', { schemaVersion: 1, nodes: [] }, 'edges'],
    [
      'bad node key',
      { schemaVersion: 1, nodes: [{ key: '1bad', kind: 'ACTION', type: 'x' }], edges: [] },
      'nodes.0.key',
    ],
    [
      'unknown kind',
      { schemaVersion: 1, nodes: [{ key: 'a', kind: 'LOOP', type: 'x' }], edges: [] },
      'nodes.0.kind',
    ],
    ['extra property', { schemaVersion: 1, nodes: [], edges: [], script: 'x' }, 'definition'],
    [
      'bad branch',
      { schemaVersion: 1, nodes: [], edges: [{ from: 'a', to: 'b', branch: 'maybe' }] },
      'edges.0.branch',
    ],
  ])('rejects %s with a field path', (_label, raw, field) => {
    const parsed = parseDefinition(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.map((e) => e.field)).toContain(field);
  });
});
