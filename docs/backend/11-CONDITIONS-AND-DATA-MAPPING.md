# 11 — Conditions and Data Mapping

**Status:** COMPLETE (2026-10-01) — evidence below; see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

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
| FR-11.4 | Conditions are a tree: groups `{ all: [...] }` (AND), `{ any: [...] }` (OR), `{ not: node }` (NOT) containing comparisons `{ left, operator, right? }`, where operands are `{ ref }` or `{ value }` (both sides may be references). Nesting up to 4 groups deep, at most 50 comparisons, 20 entries per group. |
| FR-11.5 | Operators: `equals`, `notEquals`, `greaterThan`, `greaterThanOrEqual`, `lessThan`, `lessThanOrEqual`, `contains`, `startsWith`, `endsWith`, `exists`, `notExists`, `isEmpty`, `isNotEmpty`. |
| FR-11.6 | Publish-time validation rejects: malformed references, references to unknown nodes, references to nodes that are not ancestors of the current node, unknown operators, missing `right` operand. |
| FR-11.7 | Missing values: `exists`/`notExists` test presence; any other operator with a missing operand evaluates to `false` (never throws). Templates render missing values as empty string and record a warning in step metadata. |

### Type rules

| Operator | Semantics |
| --- | --- |
| equals / notEquals | Strict equality for primitives; no coercion (`"1"` ≠ `1`); arrays/objects compared by deep equality |
| contains | string ⊃ substring (case-sensitive) or array includes primitive; otherwise `false` |
| greaterThan(OrEqual) / lessThan(OrEqual) | both numbers, or both ISO-8601 date strings; otherwise `false` |
| startsWith / endsWith | both strings, case-sensitive; otherwise `false` |
| exists / notExists | value is present and not `null` / absent or `null` |
| isEmpty / isNotEmpty | `""`, `[]`, `{}`, missing or `null` are empty; numbers and booleans never are |

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

**Future (not in this part): a text expression mode** for advanced users, e.g. `steps.ai.output.priority == "HIGH" && trigger.issue.labels contains "production"`. It would be a parser that compiles text into the same structured condition tree, so evaluation and security stay unchanged. Deferred so the parser does not become a project inside the project.

## Dependencies

Parts 05, 08.

## Risks / Design Questions

- Limited expressiveness is intentional. If users need transformation later, add named, audited transform nodes rather than an expression language.
- Regex operator omitted to avoid ReDoS.

## Implementation Notes

Replaces the scaffold `ConditionEvaluatorService` stub (`field/operator/value` shape).

State after Part 08: the engine calls a `ValueResolver` port (currently `identityResolver`) before every step, and the built-in `condition` handler is a placeholder that fails with VALIDATION. This part implements the resolver and replaces the placeholder handler; the engine needs no changes.

## Implementation Evidence

Verified 2026-10-01 on branch `feat/part-11-09-conditions-and-webhooks` (from `main` at `5870345`).

### Design decisions

- **Nested AND/OR/NOT and extra operators** were added during implementation at the product owner's request (structured builder first; text expressions later). Limits keep evaluation cost bounded.
- **Operands are `{ ref }` / `{ value }` on both sides** rather than `field`/`value`, so two outputs can be compared; a builder UI maps "field / operator / value" onto it directly.
- **Condition configs are not pre-resolved.** Action configs pass through the resolver; condition operands are resolved by the condition handler itself, so "missing" stays distinguishable from `null`. Condition `value` operands are literals (`{{ }}` inside them is plain text, not a template).
- **Missing references** render as `""` in templates and `null` for `{ ref }`, and are logged by the worker (with the node key and references, no values).

### What was implemented

| Item | Location |
| --- | --- |
| Reference grammar, resolver (own properties only, `__proto__`/`constructor`/`prototype` rejected, `MISSING` vs `null`) | `src/engine/expressions/reference.ts` |
| Templates and `{ ref }` mapping (single pass, 16 KB cap), reference collection | `src/engine/expressions/mapping.ts` |
| Condition schema (nested groups, limits, operand pairing) and evaluator | `src/engine/expressions/conditions.ts` |
| Worker resolver + real `condition` handler (replaces the Part 08 placeholder) | `expression-resolver.ts`, `built-in-handlers.ts`, `src/execution/execution.module.ts` |
| Validator codes `INVALID_REFERENCE`, `UNKNOWN_REFERENCE_NODE`, `NON_ANCESTOR_REFERENCE`, `INVALID_CONDITION` | `src/engine/validation/graph-validator.ts` |
| ESLint `no-eval`, `no-implied-eval`, `no-new-func` as errors repo-wide; `expressions/` added to the engine architecture test | `eslint.config.mjs`, `src/engine/architecture.spec.ts` |

### Command results

| Command | Result |
| --- | --- |
| prettier check, lint, typecheck, build | pass |
| `npm test` | 317 passed |
| `npm run test:e2e` | 16 passed |
| `npm run test:int` | 161 passed |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-11.1 | PASS | Integration with a real worker: `trigger.issue.labels contains "production"` sends the run down the true branch; without the label, the false branch |
| AC-11.2 | PASS | Integration: `steps.classify.output.message == "HIGH" AND (labels contains security OR bug) AND NOT author is Bot` over four inputs, each taking the expected branch |
| AC-11.3 | PASS | Unit: every rule code. Integration: a reference to a later step is reported on save (`NON_ANCESTOR_REFERENCE`) and publish is refused (422); `trigger.constructor.prototype` → `INVALID_REFERENCE` |
| AC-11.4 | PASS | No `eval`/`Function`/`vm`/expression library; ESLint rules active (`--print-config` shows them as errors); resolver never reads the prototype chain (unit); 300 random-input evaluations never throw unexpectedly and leave `Object.prototype` untouched |
| AC-11.5 | PASS | Unit: missing vs null vs empty for every operator; templates render missing as "" and report them |

Also: templates are single-pass (a value containing `{{ … }}` is never re-interpreted); data from earlier steps is mapped into later configs (`Issue #7 "Login fails" is HIGH`), and the resolved config is what is stored as the step input.
