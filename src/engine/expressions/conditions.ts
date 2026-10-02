import { z } from 'zod';
import { MISSING, parseReference, ReferenceScope, Resolved, resolveReference } from './reference';

/**
 * Condition config and evaluation: a small, structured decision engine — never code.
 *
 * A condition is a tree of groups and comparisons:
 *
 *   { "all": [ cmp, { "any": [cmp, cmp] }, { "not": cmp } ] }      AND / OR / NOT
 *   cmp = { "left": operand, "operator": "...", "right": operand }
 *   operand = { "ref": "steps.ai.output.priority" } | { "value": "HIGH" }
 *
 * Both sides may be references, so two earlier outputs can be compared. Nesting depth is
 * limited to 4 and the number of comparisons to 50, so evaluation cost stays bounded.
 *
 * Operators — explicit type rules, no coercion:
 *   equals / notEquals                    strict for primitives ("1" ≠ 1); deep equality for arrays/objects
 *   greaterThan(OrEqual) / lessThan(OrEqual)  both numbers, or both ISO-8601 date strings; otherwise false
 *   contains                              string contains substring, or array includes a primitive
 *   startsWith / endsWith                 both strings (case-sensitive); otherwise false
 *   exists / notExists                    value present and not null / absent or null      (no right operand)
 *   isEmpty / isNotEmpty                  "", [] or {} / anything else that exists          (no right operand)
 *
 * A comparison with a missing operand is false (except exists/notExists/isEmpty, which
 * handle absence explicitly) — never an error.
 */

export const OPERATORS = [
  'equals',
  'notEquals',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
  'contains',
  'startsWith',
  'endsWith',
  'exists',
  'notExists',
  'isEmpty',
  'isNotEmpty',
] as const;
export type Operator = (typeof OPERATORS)[number];
export const UNARY_OPERATORS: readonly Operator[] = [
  'exists',
  'notExists',
  'isEmpty',
  'isNotEmpty',
];

export const CONDITION_LIMITS = { maxDepth: 4, maxComparisons: 50, maxGroupSize: 20 } as const;

const operandSchema = z.union([
  z.object({ ref: z.string().min(1).max(300) }).strict(),
  z.object({ value: z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]) }).strict(),
]);

const comparisonSchema = z
  .object({ left: operandSchema, operator: z.enum(OPERATORS), right: operandSchema.optional() })
  .strict()
  .superRefine((c, ctx) => {
    const unary = UNARY_OPERATORS.includes(c.operator);
    if (unary && c.right) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['right'],
        message: `"${c.operator}" takes no right operand`,
      });
    }
    if (!unary && !c.right) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['right'],
        message: `"${c.operator}" needs a right operand`,
      });
    }
  });

export type Operand = z.infer<typeof operandSchema>;
export type Comparison = z.infer<typeof comparisonSchema>;
export type ConditionGroup =
  { all: ConditionNode[] } | { any: ConditionNode[] } | { not: ConditionNode };
export type ConditionNode = Comparison | ConditionGroup;

const groupSchema: z.ZodType<ConditionGroup> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(nodeSchema).min(1).max(CONDITION_LIMITS.maxGroupSize) }).strict(),
    z.object({ any: z.array(nodeSchema).min(1).max(CONDITION_LIMITS.maxGroupSize) }).strict(),
    z.object({ not: nodeSchema }).strict(),
  ]),
);
const nodeSchema: z.ZodType<ConditionNode> = z.lazy(() => z.union([comparisonSchema, groupSchema]));

/** The node config of a `condition` node: always a group at the top. */
export const conditionConfigSchema = groupSchema.superRefine((root, ctx) => {
  const { depth, comparisons } = measure(root);
  if (depth > CONDITION_LIMITS.maxDepth) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Conditions may nest at most ${CONDITION_LIMITS.maxDepth} groups deep`,
    });
  }
  if (comparisons > CONDITION_LIMITS.maxComparisons) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `At most ${CONDITION_LIMITS.maxComparisons} comparisons per condition`,
    });
  }
});

export type ConditionConfig = ConditionGroup;

const isComparison = (n: ConditionNode): n is Comparison => 'operator' in n;

function measure(node: ConditionNode, depth = 0): { depth: number; comparisons: number } {
  if (isComparison(node)) return { depth, comparisons: 1 };
  const children = 'not' in node ? [node.not] : 'all' in node ? node.all : node.any;
  return children.reduce(
    (acc, child) => {
      const m = measure(child, depth + 1);
      return { depth: Math.max(acc.depth, m.depth), comparisons: acc.comparisons + m.comparisons };
    },
    { depth: depth + 1, comparisons: 0 },
  );
}

export function evaluateCondition(node: ConditionNode, scope: ReferenceScope): boolean {
  if (isComparison(node)) return evaluateComparison(node, scope);
  if ('not' in node) return !evaluateCondition(node.not, scope);
  if ('all' in node) return node.all.every((child) => evaluateCondition(child, scope));
  return node.any.some((child) => evaluateCondition(child, scope));
}

function evaluateComparison(c: Comparison, scope: ReferenceScope): boolean {
  const left = resolveOperand(c.left, scope);
  switch (c.operator) {
    case 'exists':
      return left !== MISSING && left !== null;
    case 'notExists':
      return left === MISSING || left === null;
    case 'isEmpty':
      return isEmpty(left);
    case 'isNotEmpty':
      return left !== MISSING && left !== null && !isEmpty(left);
  }

  const right = c.right ? resolveOperand(c.right, scope) : MISSING;
  if (left === MISSING || right === MISSING) return false;

  switch (c.operator) {
    case 'equals':
      return deepEqual(left, right);
    case 'notEquals':
      return !deepEqual(left, right);
    case 'greaterThan':
      return compare(left, right) === 1;
    case 'greaterThanOrEqual':
      return [0, 1].includes(compare(left, right) as number);
    case 'lessThan':
      return compare(left, right) === -1;
    case 'lessThanOrEqual':
      return [0, -1].includes(compare(left, right) as number);
    case 'contains':
      return contains(left, right);
    case 'startsWith':
      return typeof left === 'string' && typeof right === 'string' && left.startsWith(right);
    case 'endsWith':
      return typeof left === 'string' && typeof right === 'string' && left.endsWith(right);
  }
}

function resolveOperand(o: Operand, scope: ReferenceScope): Resolved {
  return 'ref' in o ? resolveReference(parseReference(o.ref), scope) : o.value;
}

/** "", [] and {} are empty; missing and null count as empty too. Numbers/booleans never are. */
function isEmpty(value: Resolved): boolean {
  if (value === MISSING || value === null) return true;
  if (typeof value === 'string' || Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function contains(haystack: unknown, needle: unknown): boolean {
  if (typeof haystack === 'string' && typeof needle === 'string') return haystack.includes(needle);
  if (Array.isArray(haystack) && (needle === null || typeof needle !== 'object')) {
    return haystack.some((item) => item === needle);
  }
  return false;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** -1 / 0 / 1, or null when the values are not comparable. */
function compare(a: unknown, b: unknown): -1 | 0 | 1 | null {
  let x: number;
  let y: number;
  if (typeof a === 'number' && typeof b === 'number') {
    x = a;
    y = b;
  } else if (
    typeof a === 'string' &&
    typeof b === 'string' &&
    ISO_DATE.test(a) &&
    ISO_DATE.test(b)
  ) {
    x = Date.parse(a);
    y = Date.parse(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return null;
  } else {
    return null;
  }
  return x === y ? 0 : x > y ? 1 : -1;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => Object.hasOwn(b, k) && deepEqual((a as never)[k], (b as never)[k]))
  );
}
