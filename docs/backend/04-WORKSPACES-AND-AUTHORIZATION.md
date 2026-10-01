# 04 — Workspaces and Authorization

**Status:** COMPLETE (2026-10-01) — evidence below; see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Make the workspace the unit of tenancy and enforce, in the backend, that a user can only see and change resources of workspaces they belong to, with role-based restrictions inside a workspace.

## Why This Part Exists

FlowForge stores other people's workflows, run payloads and integration credentials. Insecure direct object reference ("change the ID in the URL") is the most likely serious vulnerability in a multi-tenant API. This part builds the single mechanism every later controller uses and proves it with tests.

## Scope

Workspace creation and listing, membership management, roles, a workspace access guard, a role decorator, an authorization service, and the resource-scoping pattern that all later services follow.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-04.1 | Authenticated user can create a workspace and becomes its `OWNER`. |
| FR-04.2 | User can list only workspaces they are a member of, with their role. |
| FR-04.3 | Members can view a workspace; `OWNER`/`ADMIN` can rename it; only `OWNER` can delete it. |
| FR-04.4 | `OWNER`/`ADMIN` can add an existing user by email, change roles and remove members, subject to role rules below. |
| FR-04.5 | A workspace always has at least one `OWNER`. |
| FR-04.6 | Any request for a workspace the user is not a member of — or for a resource belonging to another workspace — returns `404 Not Found`. |
| FR-04.7 | A member lacking the required role receives `403 Forbidden`. |

### Role matrix

| Capability | OWNER | ADMIN | MEMBER |
| --- | :-: | :-: | :-: |
| View workspace, workflows, runs, connections (metadata) | ✓ | ✓ | ✓ |
| Create/edit workflow drafts, duplicate | ✓ | ✓ | ✓ |
| Publish, archive, delete workflows; manual run retry/cancel | ✓ | ✓ | ✗ |
| Connect/disconnect integrations | ✓ | ✓ | ✗ |
| Manage members (non-owners) | ✓ | ✓ | ✗ |
| Grant/revoke OWNER, delete workspace | ✓ | ✗ | ✗ |

Justification: MEMBERs can build but not change what runs in production or which external accounts are connected; that matches how teams typically separate authoring from operating.

## Technical Requirements

- **Routing convention:** all tenant resources live under `/api/v1/workspaces/:workspaceId/...`. The workspace is explicit in the URL, never implied by a token claim.
- **`WorkspaceAccessGuard`:** registered **globally** (after `AuthGuard`) rather than per controller, so every route with a `:workspaceId` parameter is checked and a new controller cannot forget it. Reads `:workspaceId`, validates it as a UUID, loads the membership in one indexed query, returns 404 if absent, attaches `request.workspace = { workspaceId, userId, role }`. `@RequireRole` on a route without `:workspaceId` fails closed (500).
- **`@RequireRole('ADMIN')`:** decorator + check inside the same guard using the role hierarchy `OWNER > ADMIN > MEMBER`.
- **Resource scoping:** every service method takes `workspaceId` as the first argument and includes it in the `where` clause (`findFirst({ where: { id, workspaceId } })`). A shared helper throws `NotFoundException` when null. No service method loads a tenant resource by `id` alone.
- **Authorization service:** `AuthorizationService.assertRole(membership, required)` and `canManageMember(actor, target, newRole)` hold rule logic so it is unit-testable without HTTP.
- Audit events for membership changes.

## API Changes

| Method | Path | Min role |
| --- | --- | --- |
| POST | `/api/v1/workspaces` | authenticated |
| GET | `/api/v1/workspaces` | authenticated |
| GET | `/api/v1/workspaces/:workspaceId` | MEMBER |
| PATCH | `/api/v1/workspaces/:workspaceId` | ADMIN |
| DELETE | `/api/v1/workspaces/:workspaceId` | OWNER |
| GET | `/api/v1/workspaces/:workspaceId/members` | MEMBER |
| POST | `/api/v1/workspaces/:workspaceId/members` | ADMIN (`{ email, role }`) |
| PATCH | `/api/v1/workspaces/:workspaceId/members/:userId` | ADMIN / OWNER per matrix |
| DELETE | `/api/v1/workspaces/:workspaceId/members/:userId` | ADMIN / OWNER per matrix, or self-leave |

The scaffold's un-scoped routes moved under the workspace prefix in this part (their handlers still return 501 until Parts 05–17), with role requirements from the matrix already applied: `/workspaces/:workspaceId/workflows`, `/runs`, `/integrations`, `/dashboard`. Provider-level routes stay outside: `GET /integrations/providers` (authenticated) and `GET /integrations/:provider/callback` (public, state-authenticated).

## Database Changes

None beyond Part 02 (`Workspace`, `WorkspaceMember`, `AuditEvent`).

## Security Requirements

- 404 (not 403) for non-membership avoids confirming that a workspace or resource exists.
- Membership is re-checked on every request; no caching beyond the request.
- User IDs/emails of non-co-members are never returned.
- Adding a member does not reveal whether the email exists: response is `404 User not found` only to ADMIN+ of the workspace (accepted trade-off; invitations are out of scope).

## Testing Requirements

- Unit: role hierarchy, member-management rules incl. last-owner protection.
- Integration **tenant-isolation suite** (must exist and stay green): two users, two workspaces; user A tries every `:workspaceId` route and every resource route with workspace B's IDs (both `workspaceId` of B, and `workspaceId` of A with resource ID from B). All must return 404 and must not mutate data (verify via DB after the call). Later parts add their routes to this suite.
- Role tests: MEMBER receives 403 on ADMIN routes; ADMIN receives 403 on OWNER routes.

## Deliverables

`WorkspacesModule` (controller/service), `MembersController`/`MembersService`, global `WorkspaceAccessGuard`, `@RequireRole`, `WorkspacePolicy` (the spec's "authorization service": pure role rules), `@CurrentWorkspace()` decorator, `test/integration/tenant-isolation.int-spec.ts`.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-04.1 | Creating a workspace makes creator OWNER | Integration |
| AC-04.2 | List returns only the caller's workspaces | Integration with two users |
| AC-04.3 | Non-member access to any workspace route → 404, no data changed | Tenant-isolation suite |
| AC-04.4 | Resource ID from another workspace under own workspace path → 404 | Tenant-isolation suite (extended by later parts) |
| AC-04.5 | MEMBER → 403 on ADMIN routes; ADMIN → 403 on OWNER routes | Integration |
| AC-04.6 | Last OWNER cannot be demoted/removed | Unit + integration |
| AC-04.7 | Authorization enforced with a raw HTTP client (no frontend) | All above use Supertest directly |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Email invitations, custom roles, per-workflow permissions, SSO, PostgreSQL RLS.

## Dependencies

Parts 02, 03.

## Risks / Design Questions

- **Forgotten scoping in a new service** is the main risk. Mitigations: the helper pattern, code review checklist in Part 22, and the tenant-isolation suite that every new resource route must join.
- **RLS** would give defence in depth but complicates Prisma connection handling; deferred.

## Implementation Notes

- The scaffold's `AuthenticatedUser.workspaceId` field is removed; controllers use `@CurrentWorkspace()` instead.
- The scaffold's `WorkspaceAccessGuard` stub (always false) is replaced.

## Implementation Evidence

Verified 2026-10-01 on branch `feat/part-04-workspaces` (from `main` at `0308b57`).

### What was implemented

| Item | Location |
| --- | --- |
| Workspace create/list/get/rename/delete | `src/modules/workspaces/workspaces.controller.ts`, `workspaces.service.ts` |
| Member list/add/change role/remove/leave, last-owner protection, per-workspace row lock, actor role re-read inside the transaction | `members.controller.ts`, `members.service.ts` |
| Pure role rules | `workspace-policy.ts` |
| Global tenant guard (404 non-member/malformed id, 403 insufficient role) | `src/common/guards/workspace-access.guard.ts`, registered in `app.module.ts` |
| `@RequireRole`, `@CurrentWorkspace` | `src/common/decorators/` |
| Scaffold workflow/run/integration/dashboard routes moved under `/workspaces/:workspaceId` with roles; interim `pendingWorkspaceScope` from Part 03 removed | `src/modules/{workflows,runs,integrations,dashboard}/*.controller.ts` |
| Audit: `workspace.created/renamed/deleted`, `member.added/role_changed/removed/left` | services |

### Command results

| Command | Result |
| --- | --- |
| prettier check, lint, typecheck, build | pass |
| `npm test` | 101 passed (incl. 36 policy cases, 7 guard cases) |
| `npm run test:e2e` | 14 passed |
| `npm run test:int` | 108 passed |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-04.1 | PASS | Integration: 201, role OWNER, membership row + audit event |
| AC-04.2 | PASS | Integration: member sees exactly personal + shared workspace with correct roles; isolation suite: Alice's list contains only her workspace |
| AC-04.3 | PASS | Isolation suite discovers all **26** `:workspaceId` routes from the live router and calls each as a non-member → all 404; Bob's workspace and memberships unchanged afterwards. Unauthenticated → all 401; malformed ids → all 404 |
| AC-04.4 | PASS | Alice changing/removing Bob's membership through her own workspace path → 404, Bob's membership unchanged. Foreign-workspace 404 body identical to non-existent-workspace 404 |
| AC-04.5 | PASS | Integration: MEMBER 403 on rename/add/change/remove and on publish/retry/connect; ADMIN 403 on delete workspace, granting OWNER, touching an OWNER; OWNER can grant OWNER |
| AC-04.6 | PASS | Integration: demoting or removing the last OWNER → 409; allowed once a second owner exists. Concurrent mutual demotion of two owners → exactly one owner remains |
| AC-04.7 | PASS | All checks use Supertest against the HTTP API, no frontend involved |

**Mutation check:** with the global guard temporarily removed from `app.module.ts`, the isolation suite failed (3 of 7 tests: cross-tenant, malformed ids, foreign member). With it restored, all pass. This shows the suite catches the regression it exists for.

### Notes

- In the concurrent demotion test the losing request gets **403**, not 409: it waits for the workspace lock, re-reads its own role inside the transaction, finds it was just demoted to ADMIN, and may no longer touch an OWNER. That is the stale-role protection working as intended.
- Membership is checked with one indexed lookup per workspace-scoped request; there is no caching, so removals and demotions take effect on the next request (tested).
- Adding a member reveals to ADMIN+ whether an email is registered (404). Accepted; email invitations are out of scope.
