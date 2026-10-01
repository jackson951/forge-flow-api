# 04 — Workspaces and Authorization

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

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
- **`WorkspaceAccessGuard`:** reads `:workspaceId`, validates it as a UUID, loads the membership in one indexed query, returns 404 if absent, attaches `request.workspace = { id, role }`.
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

The scaffold's un-scoped routes (`/api/workflows`, `/api/runs`, `/api/integrations`, `/api/dashboard`) move under the workspace prefix in the parts that implement them.

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

`WorkspacesModule` (controller/service), `MembersController`, `WorkspaceAccessGuard`, `@RequireRole`, `AuthorizationService`, `@CurrentWorkspace()` decorator, `test/integration/tenant-isolation.int-spec.ts`.

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
