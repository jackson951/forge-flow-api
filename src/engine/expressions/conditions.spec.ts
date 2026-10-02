import { randomBytes } from 'node:crypto';
import {
  Comparison,
  ConditionNode,
  conditionConfigSchema,
  deepEqual,
  evaluateCondition,
  Operator,
} from './conditions';

const scope = {
  trigger: {
    issue: {
      title: 'Login crash in production',
      labels: ['bug', 'production'],
      count: 5,
      createdAt: '2026-10-01T10:00:00Z',
      author: { type: 'User', login: 'ada' },
      body: null,
      empty: '',
      emptyList: [],
      emptyObject: {},
    },
  },
  outputs: { ai: { priority: 'HIGH', category: 'SECURITY', score: 0.92 } },
};

const ref = (r: string) => ({ ref: r });
const val = (v: string | number | boolean | null) => ({ value: v });
const cmp = (
  left: Comparison['left'],
  operator: Operator,
  right?: Comparison['right'],
): Comparison => (right ? { left, operator, right } : { left, operator });
const check = (node: ConditionNode) => evaluateCondition(node, scope);
const one = (c: Comparison) => check({ all: [c] });

describe('evaluateCondition — operators', () => {
  it.each([
    // equals / notEquals: strict, no coercion
    [cmp(ref('steps.ai.output.priority'), 'equals', val('HIGH')), true],
    [cmp(ref('steps.ai.output.priority'), 'equals', val('high')), false],
    [cmp(ref('trigger.issue.count'), 'equals', val('5')), false],
    [cmp(ref('trigger.issue.count'), 'equals', val(5)), true],
    [cmp(ref('trigger.issue.body'), 'equals', val(null)), true],
    [cmp(ref('trigger.issue.missing'), 'equals', val(null)), false],
    [cmp(ref('steps.ai.output.category'), 'notEquals', val('BUG')), true],
    [cmp(ref('trigger.issue.missing'), 'notEquals', val('BUG')), false],
    // ref vs ref, deep equality
    [cmp(ref('trigger.issue.labels'), 'equals', ref('trigger.issue.labels')), true],
    // numeric and date comparisons
    [cmp(ref('trigger.issue.count'), 'greaterThan', val(4)), true],
    [cmp(ref('trigger.issue.count'), 'greaterThan', val(5)), false],
    [cmp(ref('trigger.issue.count'), 'greaterThanOrEqual', val(5)), true],
    [cmp(ref('trigger.issue.count'), 'lessThan', val(10)), true],
    [cmp(ref('trigger.issue.count'), 'lessThanOrEqual', val(4)), false],
    [cmp(ref('trigger.issue.count'), 'greaterThan', val('4')), false],
    [cmp(ref('trigger.issue.createdAt'), 'greaterThan', val('2026-09-30')), true],
    [cmp(ref('trigger.issue.createdAt'), 'lessThan', val('2026-09-30T00:00:00Z')), false],
    [cmp(ref('trigger.issue.title'), 'greaterThan', val('A')), false],
    // contains / startsWith / endsWith
    [cmp(ref('trigger.issue.labels'), 'contains', val('production')), true],
    [cmp(ref('trigger.issue.labels'), 'contains', val('prod')), false],
    [cmp(ref('trigger.issue.title'), 'contains', val('crash')), true],
    [cmp(ref('trigger.issue.title'), 'contains', val('Crash')), false],
    [cmp(ref('trigger.issue.count'), 'contains', val(5)), false],
    [cmp(ref('trigger.issue.title'), 'startsWith', val('Login')), true],
    [cmp(ref('trigger.issue.title'), 'endsWith', val('production')), true],
    [cmp(ref('trigger.issue.count'), 'startsWith', val('5')), false],
    // presence and emptiness
    [cmp(ref('trigger.issue.author'), 'exists'), true],
    [cmp(ref('trigger.issue.body'), 'exists'), false],
    [cmp(ref('trigger.issue.assignee'), 'exists'), false],
    [cmp(ref('trigger.issue.assignee'), 'notExists'), true],
    [cmp(ref('trigger.issue.empty'), 'isEmpty'), true],
    [cmp(ref('trigger.issue.emptyList'), 'isEmpty'), true],
    [cmp(ref('trigger.issue.emptyObject'), 'isEmpty'), true],
    [cmp(ref('trigger.issue.assignee'), 'isEmpty'), true],
    [cmp(ref('trigger.issue.count'), 'isEmpty'), false],
    [cmp(ref('trigger.issue.labels'), 'isNotEmpty'), true],
    [cmp(ref('trigger.issue.empty'), 'isNotEmpty'), false],
  ] as [Comparison, boolean][])('%j → %s', (comparison, expected) => {
    expect(one(comparison)).toBe(expected);
  });

  it('a missing operand makes any binary comparison false', () => {
    for (const op of [
      'equals',
      'greaterThan',
      'lessThan',
      'contains',
      'startsWith',
    ] as Operator[]) {
      expect(one(cmp(ref('trigger.nothing'), op, val('x')))).toBe(false);
      expect(one(cmp(val('x'), op, ref('trigger.nothing')))).toBe(false);
    }
  });
});

describe('evaluateCondition — groups', () => {
  const high = cmp(ref('steps.ai.output.priority'), 'equals', val('HIGH'));
  const security = cmp(ref('steps.ai.output.category'), 'equals', val('SECURITY'));
  const bug = cmp(ref('steps.ai.output.category'), 'equals', val('BUG'));
  const fromBot = cmp(ref('trigger.issue.author.type'), 'equals', val('Bot'));

  it('priority == HIGH AND (category == SECURITY OR category == BUG) AND NOT author is bot', () => {
    expect(check({ all: [high, { any: [security, bug] }, { not: fromBot }] })).toBe(true);
    expect(check({ all: [high, { any: [bug] }] })).toBe(false);
    expect(check({ any: [{ all: [bug] }, { not: high }] })).toBe(false);
    expect(check({ not: { all: [high, security] } })).toBe(false);
  });
});

describe('conditionConfigSchema', () => {
  const c = cmp(ref('trigger.a'), 'equals', val(1));
  const nest = (depth: number): ConditionNode => (depth === 0 ? c : { all: [nest(depth - 1)] });

  it('accepts nested groups within the limits', () => {
    expect(conditionConfigSchema.safeParse(nest(4)).success).toBe(true);
  });

  it('rejects nesting deeper than 4 and more than 50 comparisons', () => {
    expect(conditionConfigSchema.safeParse(nest(5)).success).toBe(false);
    const wide = {
      all: Array.from({ length: 3 }, () => ({ any: Array.from({ length: 20 }, () => c) })),
    };
    expect(conditionConfigSchema.safeParse(wide).success).toBe(false);
  });

  it.each([
    [{ all: [cmp(ref('trigger.a'), 'equals')] }, 'needs a right operand'],
    [{ all: [cmp(ref('trigger.a'), 'exists', val(1))] }, 'takes no right operand'],
    [{ all: [{ left: ref('trigger.a'), operator: 'matches', right: val('.*') }] }, 'operator'],
    [{ all: [] }, 'all'],
    [{ all: [c], any: [c] }, ''],
    [{ all: [{ left: { ref: 'trigger.a', value: 1 }, operator: 'exists' }] }, ''],
    [{ all: [{ left: { code: 'process.exit()' }, operator: 'exists' }] }, ''],
  ] as [unknown, string][])('rejects %j', (config) => {
    expect(conditionConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe('safety', () => {
  it('evaluating random strings as references or values never throws unexpectedly or runs code', () => {
    const before = Object.keys(Object.prototype).length;
    for (let i = 0; i < 300; i++) {
      const junk = randomBytes(12).toString('latin1');
      const config = {
        all: [cmp(val(junk), 'equals', val(junk)), cmp(val(junk), 'contains', val('a'))],
      };
      expect(typeof check(config)).toBe('boolean');
      try {
        check({ all: [cmp(ref(junk), 'exists')] });
      } catch (err) {
        expect((err as Error).name).toBe('ReferenceSyntaxError');
      }
    }
    expect(Object.keys(Object.prototype).length).toBe(before);
  });
});

describe('deepEqual', () => {
  it('compares structurally', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });
});
