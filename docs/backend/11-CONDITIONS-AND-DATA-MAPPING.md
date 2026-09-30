# 11 — Conditions and Data Mapping

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

## Objective

Define and implement a safe, declarative data layer between nodes: path references to trigger data and earlier step outputs, string templates for node inputs, and a condition evaluator with a fixed operator set — with no arbitrary code execution.

## Why This Part Exists

Useful workflows depend on earlier data ("if the AI said HIGH, post the issue title to Slack"). Expression languages are a classic injection and prototype-pollution vector; a closed, schema-validated design removes that risk.

## Scope

Reference syntax and grammar, value resolver, template interpolation, condition model and evaluator, publish-time validation of references, missing-value and type rules.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-11.1 | References: `trigger.<path>` and `steps.<nodeKey>.output.<path>`; path segments are identifiers or non-negative integer indexes (`trigger.issue.labels.0.name`). |
| FR-11.2 | Templates: string config fields may contain `{{ <reference> }}` placeholders; no filters, operators or function calls. |
| FR-11.3 | A config value `{ "ref": "<reference>" }` resolves to the referenced value with its type preserved. |
| FR-11.4 | Conditions: `{ all: [...] }` or `{ any: [...] }` of clauses `{ left, operator, right? }` where operands are `{ ref }` or `{ value }`. One nesting level of `all`/`any` allowed. |
| FR-11.5 | Operators: `equals`, `notEquals`, `contains`, `greaterThan`, `lessThan`, `exists`, `notExists`. |
| FR-11.6 | Publish-time validation rejects: malformed references, references to unknown nodes, references to nodes that are not ancestors of the current node, unknown operators, missing `right` operand. |
| FR-11.7 | Missing values: `exists`/`notExists` test presence; any other operator with a missing operand evaluates to `false` (never throws). Templates render missing values as empty string and record a warning in step metadata. |

### Type rules

| Operator | Semantics |
| --- | --- |
| equals / notEquals | Strict equality for primitives; no coercion (`"1"` ≠ `1`); arrays/objects compared by deep equality |
| contains | string ⊃ substring (case-sensitive) or array includes primitive; otherwise `false` |
| greaterThan / lessThan | both numbers, or both ISO-8601 date strings; otherwise `false` |
| exists | value is not `undefined` and not `null` |

## Technical Requirements

- Reference parser: hand-written tokenizer/regex `^(trigger|steps\.[a-zA-Z][a-zA-Z0-9_]{0,63}\.output)(\.([a-zA-Z_][a-zA-Z0-9_]{0,63}|\d{1,6}))*$`, max 20 segments.
- Resolver walks own properties only (`Object.hasOwn`), refuses `__proto__`, `constructor`, `prototype` segments, and never invokes getters or functions.
- Templates: single-pass regex replacement `\{\{\s*(ref)\s*\}\}`; results are strings; resolved objects are JSON-stringified; output length capped (16 KB).
- Zod schemas for condition config shared by validator (Part 05) and evaluator.
- Ancestor check uses the tree structure from Part 05 (every node has one parent chain).
- No use of `eval`, `new Function`, `vm`, or third-party expression engines. A lint rule (`no-eval`, `no-new-func`, `no-implied-eval`) is enforced repo-wide.

## API Changes

None; validation issues surface through Part 05/06 endpoints with new codes `INVALID_REFERENCE`, `UNKNOWN_REFERENCE_NODE`, `NON_ANCESTOR_REFERENCE`, `INVALID_CONDITION`.

## Database Changes

None.

## Security Requirements

- Prototype-pollution attempts (`trigger.__proto__.x`, `constructor.prototype`) rejected at validation and at runtime.
- Templates cannot produce credentials: the resolution context contains only trigger data and step outputs (never connection data).
- Resolved values injected into provider calls are passed as data (JSON fields), never concatenated into URLs without encoding.

## Testing Requirements

Unit: parser valid/invalid cases; resolver (nested, arrays, missing, null, pollution attempts); every operator × type matrix incl. mismatches; `all`/`any`; templates with multiple/missing placeholders; ancestor validation. Property-style test: random strings never execute code / never throw from evaluator.

Integration: a workflow branching on trigger data and one branching on a previous step's output execute the correct branch.

## Deliverables

`src/engine/expressions/` (parser, resolver, template renderer, condition evaluator), `condition` handler update, validator rules, tests.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-11.1 | Workflow branches on trigger data | Integration |
| AC-11.2 | Workflow branches on previous step output | Integration |
| AC-11.3 | Invalid expressions rejected at save/publish | Unit + integration |
| AC-11.4 | Arbitrary code cannot execute (no eval; pollution blocked) | Unit tests + ESLint rules in CI |
| AC-11.5 | Missing values behave per rules | Unit |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Arithmetic, string functions, regex matching, loops over arrays, user-defined JavaScript.

## Dependencies

Parts 05, 08.

## Risks / Design Questions

- Limited expressiveness is intentional. If users need transformation later, add named, audited transform nodes rather than an expression language.
- Regex operator omitted to avoid ReDoS.

## Implementation Notes

Replaces the scaffold `ConditionEvaluatorService` stub (`field/operator/value` shape).
