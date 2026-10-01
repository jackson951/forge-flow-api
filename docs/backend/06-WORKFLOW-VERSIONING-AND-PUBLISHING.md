# 06 — Workflow Versioning and Publishing

**Status:** COMPLETE (2026-10-01) — evidence below; see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Publishing turns the current draft into an immutable, numbered `WorkflowVersion` that becomes the workflow's active version. Triggers and runs always use a published version, never the draft.

```
Draft ──publish──▶ Version 1 (active)
Draft edited ──publish──▶ Version 2 (active)   Version 1 unchanged; its runs still point to it
```

## Why This Part Exists

Without immutable versions, editing a workflow would rewrite history: past runs would appear to have executed steps they never ran, and in-flight runs could change behaviour mid-execution.

## Scope

Publish, version history, version retrieval, activation of trigger subscriptions, immutability enforcement.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-06.1 | `POST .../publish` validates the stored draft; any `error` issue → `422` with the issue list and nothing is created. |
| FR-06.2 | On success a `WorkflowVersion` is created with `version = previous max + 1`, snapshot `definition`, `definitionHash` (sha256 of canonical JSON), `publishedAt`, `publishedById`. |
| FR-06.3 | The workflow's `activeVersionId` is set to the new version and status becomes `PUBLISHED`; `WorkflowTrigger` rows are replaced for the new version. |
| FR-06.4 | Publishing an unchanged draft (same hash as active version) → `409 NO_CHANGES`. |
| FR-06.5 | Version history lists versions newest-first with metadata; a single version can be retrieved with its full definition. |
| FR-06.6 | Versions have no update or delete endpoint. |
| FR-06.7 | Publishing requires `expectedRevision` of the draft to prevent publishing a draft different from the one the user reviewed. |

## Technical Requirements

- Publish runs in one serializable transaction (or with a `SELECT … FOR UPDATE` on the workflow row) so concurrent publishes cannot create duplicate version numbers; the unique (`workflowId`, `version`) constraint is the backstop.
- Canonical JSON (sorted keys) for hashing, so equivalent definitions hash equally.
- Database trigger rejecting `UPDATE` on `WorkflowVersion.definition` and `definitionHash` (from Part 02 D2).
- Stored snapshot is the validated, normalised definition (defaults applied), so the engine never re-applies defaults that may change over time.
- Runs are created with `workflowVersionId` of the active version at trigger time (enforced in Parts 08/09).

## API Changes

Base: `/api/v1/workspaces/:workspaceId/workflows/:workflowId`

| Method | Path | Min role | Response |
| --- | --- | --- | --- |
| POST | `/publish` | ADMIN | body `{ expectedRevision }` → `201 { id, version, schemaVersion, definitionHash, publishedAt, publishedBy, isActive }`; `422` with issues in `details`; `409` stale revision / archived / `NO_CHANGES` |
| GET | `/versions` | MEMBER | `?limit=&cursor=` newest first, without definitions; `nextCursor` is the last version number |
| GET | `/versions/:version` | MEMBER | full version incl. definition |

## Database Changes

Uses `WorkflowVersion`, `WorkflowTrigger` from Part 02; adds the immutability trigger if not already present.

## Security Requirements

- Only ADMIN+ can publish (changes production behaviour).
- `publishedById` recorded; audit event `workflow.published`.
- Tenant scoping for all version queries; routes join the tenant-isolation suite.

## Testing Requirements

- Unit: canonical hashing, version-number assignment.
- Integration: invalid draft cannot publish; publish creates v1, edit + publish creates v2 and v1 is byte-identical to before; direct SQL `UPDATE` on a version definition fails; concurrent publishes yield distinct consecutive numbers; a run row referencing v1 still returns v1's definition after v2 is published; MEMBER publish → 403.

## Deliverables

Publishing service, versions controller, immutability trigger migration, tests.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-06.1 | Invalid workflow cannot publish (422, no version row) | Integration |
| AC-06.2 | Published version cannot be modified via API or SQL | Integration (no route; raw SQL update raises) |
| AC-06.3 | Modifying the draft doesn't modify earlier versions | Integration compares hash + definition |
| AC-06.4 | A run can reference an exact version and resolves it after later publishes | Integration |
| AC-06.5 | Version numbers are sequential under concurrency | Integration with parallel publishes |
| AC-06.6 | Version history lists all versions with publisher and timestamp | Integration |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Rollback to an older version (a possible later feature: "activate version n"), diffing versions, scheduled publishing.

## Dependencies

Parts 02, 04, 05.

## Risks / Design Questions

- **Integration references in snapshots:** a version snapshots `connectionId`, not credentials. If the connection is later disconnected, runs fail with `PROVIDER_AUTH` rather than silently using another account — intended.
- **Rollback** would be cheap (set `activeVersionId`) and is noted as a future improvement.

## Implementation Notes

Replaces the scaffold's single `publish` stub and `listVersions` stub.

## Implementation Evidence

Verified 2026-10-01 on branch `feat/part-06-publishing` (from `main` at `c3bb9c5`).

### What was implemented

| Item | Location |
| --- | --- |
| Publish: row lock (`SELECT … FOR UPDATE`), archived/revision checks, validation (422), canonical hash + `NO_CHANGES`, gapless version numbers, activation, routing rebuild, audit — one transaction | `src/modules/workflows/publishing.service.ts` |
| Version history (keyset by version number) and single-version retrieval | same + `workflows.controller.ts` |
| Canonical JSON (recursively sorted keys) and sha256 hash | `src/engine/definition/canonical-json.ts` |
| Trigger routing: `NodeTypeDefinition.route` hook, `deriveTriggerRoutes`, `TriggerRoutingService` used by publish, archive and unarchive (unarchive now restores the active version's routes — deferred from Part 05) | `src/engine/catalog/*`, `src/modules/workflows/trigger-routing.service.ts` |

### Command results

| Command | Result |
| --- | --- |
| prettier check, lint, typecheck, build | pass |
| `npm test` | 160 passed |
| `npm run test:e2e` | 16 passed |
| `npm run test:int` | 143 passed (11 in `publishing.int-spec.ts`) |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-06.1 | PASS | Empty draft → 422 with `NO_TRIGGER` in `details`; no version row; workflow stays DRAFT with no active version |
| AC-06.2 | PASS | Route inventory: only two GET routes exist under `/versions`; `DELETE …/versions/1` → 404; raw SQL `UPDATE` of a published definition rejected by the immutability trigger |
| AC-06.3 | PASS | After publishing v2 from an edited draft, the v1 row is deep-equal to its state before; the API returns v1 with the original content and `isActive: false` |
| AC-06.4 | PASS | A run created against v1 still resolves v1's hash and content after v2 is published |
| AC-06.5 | PASS | Three concurrent publishes of the same revision → one 201, two 409; sequential publishes produce exactly versions 1, 2, 3 |
| AC-06.6 | PASS | History newest first with `publishedBy` and `isActive`, no definitions in the list; cursor pagination; unknown version → 404, non-numeric → 400 |

Also verified: stale `expectedRevision` → 409; republishing unchanged content → 409 `NO_CHANGES`, including after re-saving the same definition with different key order (canonical hash); MEMBER → 403; publish of an archived workflow → 409; routing rows follow the active version through publish → republish → archive → unarchive; a manual trigger creates no routing rows; audit event `workflow.published` with version and hash.

### Notes

- The frozen snapshot is the parsed definition with defaults applied (e.g. a missing `config` becomes `{}`), so later default changes can never alter what a version means.
- No real webhook trigger type exists yet; the integration test registers a test-only `test.webhook` type in the running app's catalogue to exercise routing. GitHub's trigger (Part 10) will use the same `route` hook.
- Rollback ("activate version n") remains a future improvement, as specified.
