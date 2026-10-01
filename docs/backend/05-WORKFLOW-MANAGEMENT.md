# 05 — Workflow Management

**Status:** COMPLETE (2026-10-01) — evidence below; see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Let workspace members create, edit, list, duplicate, archive and delete workflows, and save a draft definition (trigger, nodes, edges, configuration) that is validated structurally and semantically. No execution.

## Why This Part Exists

The workflow definition is FlowForge's central data structure. Its format and validation rules determine what the engine (Part 08), publishing (Part 06) and integrations must handle. Rejecting malformed graphs at save/publish time keeps the engine simple.

## Scope

Workflow metadata CRUD, lifecycle status, draft definition storage with optimistic concurrency, definition schema, graph validation, node-type registry for configuration schemas (definitions only; handlers come later).

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-05.1 | Create workflow (`name`, optional `description`) → `DRAFT` with an empty draft. |
| FR-05.2 | Get one workflow incl. draft, `draftRevision`, status, active version summary. |
| FR-05.3 | List workspace workflows, cursor-paginated, filterable by status, excluding archived by default. |
| FR-05.4 | Update metadata (`name`, `description`). |
| FR-05.5 | Save draft (`PUT .../draft`) with `expectedRevision`; stale revision → `409`. Save stores structurally valid drafts even if semantically incomplete, and returns the validation issues. |
| FR-05.6 | `POST .../validate` returns the full issue list without saving. |
| FR-05.7 | Duplicate copies metadata + draft into a new `DRAFT` workflow named "Copy of …" (no versions, no runs). |
| FR-05.8 | Archive sets `ARCHIVED`, deactivates triggers; unarchive returns it to `DRAFT` or `PUBLISHED` depending on whether it has an active version. |
| FR-05.9 | Delete: hard delete allowed only if the workflow has no runs; otherwise `409` with guidance to archive. |

### Definition format (schemaVersion 1)

```json
{
  "schemaVersion": 1,
  "nodes": [
    { "key": "trigger", "kind": "TRIGGER", "type": "github.issue.created", "config": { "connectionId": "…", "repository": "owner/repo" }, "position": { "x": 0, "y": 0 } },
    { "key": "classify", "kind": "ACTION", "type": "ai.classify", "config": { "text": "{{ trigger.issue.body }}", "labels": ["BUG", "FEATURE"] } },
    { "key": "isHigh", "kind": "CONDITION", "type": "condition", "config": { "all": [{ "left": { "ref": "steps.classify.output.priority" }, "operator": "equals", "right": { "value": "HIGH" } }] } },
    { "key": "notify", "kind": "ACTION", "type": "slack.sendMessage", "config": { "connectionId": "…", "channelId": "C123", "text": "…" } }
  ],
  "edges": [
    { "from": "trigger", "to": "classify" },
    { "from": "classify", "to": "isHigh" },
    { "from": "isHigh", "to": "notify", "branch": "true" }
  ]
}
```

The trigger is a node of kind `TRIGGER` (replacing the scaffold's separate `trigger` property) so the graph is uniform. `key` is a stable, user-visible identifier (`^[a-zA-Z][a-zA-Z0-9_]{0,63}$`) used by data references (Part 11) and `StepRun.nodeKey`.

### Graph validation rules

| Code | Rule |
| --- | --- |
| `NO_TRIGGER` | Exactly one `TRIGGER` node required |
| `MULTIPLE_TRIGGERS` | More than one trigger (unsupported in v1) |
| `DUPLICATE_NODE_KEY` | Node keys must be unique |
| `UNKNOWN_NODE_TYPE` | `type` not registered for its `kind` |
| `INVALID_NODE_CONFIG` | Config fails that node type's zod schema (issue carries path) |
| `EDGE_UNKNOWN_NODE` | Edge `from`/`to` references a missing key |
| `SELF_LOOP` / `DUPLICATE_EDGE` | Invalid edges |
| `EDGE_INTO_TRIGGER` | Triggers have no incoming edges |
| `BRANCH_REQUIRED` / `BRANCH_NOT_ALLOWED` | Edges out of a condition need `branch` `true`/`false`; other edges must not have one |
| `DUPLICATE_BRANCH` | A condition has at most one edge per branch |
| `MULTIPLE_INCOMING` | v1 graphs are trees: each non-trigger node has exactly one incoming edge (no joins) |
| `CYCLE` | Cycles unsupported |
| `UNREACHABLE_NODE` | Node not reachable from the trigger (also covers disconnected nodes) |
| `CONDITION_WITHOUT_BRANCH` | Condition with no outgoing edge (warning, not error) |
| `SECRET_IN_CONFIG` | Config key that looks like a credential (`apiKey`, `token`, `client_secret`, `password`, …; exact-name match so `maxTokens` is allowed) |
| `LIMIT_EXCEEDED` | Node count > 50, edges > 100, serialized definition > 256 KB, config > 16 KB per node |

Issues: `{ code, severity: "error" | "warning", nodeKey?, edge?, path?, message }`.

## Technical Requirements

- Graph validator is a pure TypeScript module in `src/engine/validation/` (no Nest, no DB) → fast unit tests; wrapped by an injectable service.
- Definition parsing with zod (structure) followed by graph rules (semantics).
- Node type catalogue (`NodeTypeRegistry`) maps `type` → `{ kind, configSchema, displayName }`. Initial built-ins: `manual.trigger`, `condition`, `util.log` (no side effects, for testing). Integration node types register in later parts.
- Configuration must never contain secrets: config schemas reference connections by `connectionId` only; validator rejects keys named like `token`, `secret`, `password`, `apiKey` (Part 17 hardens this).
- Controllers use `WorkspaceAccessGuard` (Part 04).

## API Changes

Base: `/api/v1/workspaces/:workspaceId/workflows`

| Method | Path | Min role | Notes |
| --- | --- | --- | --- |
| GET | `/` | MEMBER | `?status=&cursor=&limit=` |
| POST | `/` | MEMBER | `201` |
| GET | `/:workflowId` | MEMBER | |
| PATCH | `/:workflowId` | MEMBER | metadata only |
| PUT | `/:workflowId/draft` | MEMBER | `{ expectedRevision, definition }` → `{ draftRevision, issues }` |
| POST | `/:workflowId/validate` | MEMBER | optional body definition; else validates stored draft |
| POST | `/:workflowId/duplicate` | MEMBER | `201` |
| POST | `/:workflowId/archive` | ADMIN | |
| POST | `/:workflowId/unarchive` | ADMIN | |
| GET | `/api/v1/node-types` (not workspace-scoped) | authenticated | built-in node catalogue |
| DELETE | `/:workflowId` | ADMIN | `204` or `409` if runs exist |

## Database Changes

Uses `Workflow` from Part 02 (`draftDefinition`, `draftRevision`, `status`).

## Security Requirements

- All queries scoped by `workspaceId`; routes added to the tenant-isolation suite.
- Payload size limits enforced before parsing (Part 18 sets global body limits; this part enforces definition limits).
- No secrets in definitions (see above).

## Testing Requirements

- Unit: one test per validation code (positive and negative), valid example workflows (linear, branching), limits.
- Integration: CRUD happy paths, concurrent draft save conflict (`409`), delete-with-runs `409`, role checks, tenant isolation for every route.

## Deliverables

Workflows controller/service/DTOs, definition zod schema, graph validator + unit tests, node type registry with built-ins, integration tests.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-05.1 | Valid workflow draft saves and returns no errors | Integration |
| AC-05.2 | Structurally malformed payload → 400 | Integration |
| AC-05.3 | Each semantic rule in the table is detected | Unit, one case per code |
| AC-05.4 | Stale `expectedRevision` → 409 | Integration |
| AC-05.5 | Unauthenticated → 401; MEMBER archive/delete → 403 | Integration |
| AC-05.6 | Cross-workspace workflow access → 404 for every route | Tenant-isolation suite |
| AC-05.7 | Delete with runs → 409; without runs → 204 | Integration |
| AC-05.8 | Duplicate produces independent draft | Integration (edit copy, original unchanged) |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Execution, publishing, templates, folders/tags, collaborative editing, joins/parallel merge semantics.

## Dependencies

Parts 02, 04.

## Risks / Design Questions

- **Tree-only graphs** restrict expressiveness (no "merge after branch"). Deliberate: removes join semantics from the engine. Revisit after Part 08 is stable.
- **Saving invalid drafts:** allowed so users don't lose work; publishing requires zero errors.

## Implementation Notes

The scaffold's `WorkflowDefinition` contract (separate `trigger` object, edges from `'trigger'`) is replaced by the schema above.

## Implementation Evidence

Verified 2026-10-01 on branch `feat/part-05-workflow-management` (from `main` at `7fbedb9`).

### What was implemented

| Item | Location |
| --- | --- |
| Definition schema (zod), structural parse with field-level errors, limits | `src/engine/definition/definition.schema.ts` |
| Pure graph validator, all rule codes in the table above | `src/engine/validation/graph-validator.ts` |
| Node-type catalogue with built-ins `manual.trigger`, `condition` (structure only; Part 11 adds reference rules), `util.log` | `src/engine/catalog/node-type-catalog.ts` |
| Workflow CRUD, draft save with optimistic concurrency, validate, duplicate, archive/unarchive (archive removes trigger routing rows), delete-only-without-runs | `src/modules/workflows/workflows.service.ts`, `workflows.controller.ts` |
| Keyset pagination (createdAt desc, id desc) with opaque cursor | `src/common/utils/cursor.ts` |
| `GET /api/v1/node-types` | `src/modules/workflows/node-types.controller.ts` |
| Publish / versions: still 501 (Part 06), but now scoped (404 for foreign ids first) | service |
| JSON body limit 300 KB (fits a 256 KB definition) | `src/app.setup.ts` |
| Body-parser errors mapped to clean 400/413 envelopes (bug found here, see below) | `src/common/http/body-parser-errors.ts`, `all-exceptions.filter.ts` |

### Command results

| Command | Result |
| --- | --- |
| prettier check, lint, typecheck, build | pass |
| `npm test` | 153 passed (45 for parser/validator) |
| `npm run test:e2e` | 16 passed |
| `npm run test:int` | 132 passed |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-05.1 | PASS | Integration: valid branching workflow saves → `{ draftRevision: 1, issues: [] }`, round-trips unchanged |
| AC-05.2 | PASS | Integration: malformed shape → 400 with field paths, revision unchanged; >50 nodes → 400 `LIMIT_EXCEEDED`; >300 KB body → 413 |
| AC-05.3 | PASS | Unit: at least one case per rule code, incl. joins, cycles, unreachable/disconnected nodes, secrets, limits; determinism; parser field paths |
| AC-05.4 | PASS | Integration: stale revision → 409 with `currentRevision`; two concurrent saves → exactly one 200 and one 409 |
| AC-05.5 | PASS | Integration: MEMBER archive/unarchive/delete → 403; unauthenticated → 401 (isolation suite) |
| AC-05.6 | PASS | Isolation suite: non-member → 404 on all workflow routes; Alice using Bob's workflow id under her own workspace → same response as an unknown id, never 2xx, Bob's data unchanged; explicit valid-body attack (get/patch/draft/duplicate/delete) → 404. **Mutation check:** removing `workspaceId` from the workflow lookup makes both resource tests fail |
| AC-05.7 | PASS | Integration: delete without runs → 204; with a run → 409 "archive it instead" (FK race also mapped to 409) |
| AC-05.8 | PASS | Integration: duplicate is an independent DRAFT ("Copy of …"); editing it leaves the original untouched |

### Found and fixed during this part

- **Oversized request bodies returned 500 (Part 01 code).** The body parser's "payload too large" error is not a Nest exception, so the filter treated it as unknown. Malformed JSON returned 400 but echoed part of the request body and had no `requestId` (the parser runs before the request-id middleware). An Express error mapper now turns parser errors into generic 400/413 responses, and the filter generates a request id when none exists yet. Unit and e2e tested.
- **Tenant test invariant corrected.** For routes that validate the body before the lookup (draft save), a foreign id gets the same 400 as any unknown id. The suite now asserts "identical to an unknown id and never 2xx", plus an explicit valid-body attack that must return 404.

### Notes

- Workflow listing orders by `createdAt` (stable under edits). It is served by the existing `(workspaceId, status, updatedAt)` index plus a filter; a dedicated `(workspaceId, createdAt)` index is left to Part 21 if measurements show the need.
- The JSON body limit (300 KB) is provisional; Part 18 owns final request limits.
