# 14 — Microsoft Graph Integration

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

## Objective

Connect a Microsoft account via Microsoft Entra ID (OAuth 2.0 authorization code + PKCE, delegated permissions) and provide one narrowly scoped action: **create a Microsoft To Do task** for the connected user.

## Why This Part Exists

It demonstrates the full OAuth lifecycle that GitHub App and Slack bot tokens don't exercise: expiring access tokens, refresh tokens, refresh-token rotation, and consent revocation — with least privilege.

## Scope

Entra app registration guide, authorize/callback, token storage and refresh, Graph client, `microsoft.todo.createTask` action, To Do list selection, error/consent handling, throttling.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-14.1 | ADMIN starts connect → Entra authorize URL with `state`, PKCE `code_challenge` (S256), scopes `openid profile offline_access User.Read Tasks.ReadWrite`. |
| FR-14.2 | Callback validates `state`, exchanges code with `code_verifier`, stores encrypted access + refresh tokens, expiry, tenant ID, user object ID, UPN/display name. |
| FR-14.3 | Before a Graph call, if the access token expires within 5 min, refresh it; persist the rotated refresh token atomically. Concurrent refreshes for one connection are serialised (Redis lock or DB row lock). |
| FR-14.4 | `GET …/microsoft/todo-lists` lists the user's To Do lists (id, displayName). |
| FR-14.5 | `microsoft.todo.createTask` config `{ connectionId, listId, title (template ≤ 255), body? (template ≤ 4 000), dueDate? }` → `{ taskId, webUrl? }`. |
| FR-14.6 | `invalid_grant` on refresh (consent revoked, password reset, token expired) → connection `NEEDS_ATTENTION`, step `PROVIDER_AUTH` (permanent). |
| FR-14.7 | 429/503 with `Retry-After` → `PROVIDER_RATE_LIMIT` retry after the given delay. |

## Technical Requirements

- **Least privilege:** delegated `Tasks.ReadWrite` only for functionality; no `Mail.*`, `Files.*`, `Calendars.*`, no application permissions, no admin consent required.
- Endpoints: `https://login.microsoftonline.com/{MICROSOFT_TENANT_ID}/oauth2/v2.0/authorize|token`, Graph `https://graph.microsoft.com/v1.0`.
- `MICROSOFT_TENANT_ID` default `common` (personal + work accounts); documented how to restrict to a single tenant.
- Client: plain `fetch` wrapper (`GraphClient`) or `@azure/msal-node` for token acquisition — decision recorded at implementation. Either way, tokens stored by FlowForge (not MSAL cache files).
- ID token validated only for display metadata; authorisation decisions never rely on it.
- `sideEffect: 'non-idempotent'` (Graph To Do has no idempotency key). Store `taskId` in `externalRef`.
- Timeout 15 s.

## API Changes

| Method | Path | Min role |
| --- | --- | --- |
| POST | `/api/v1/workspaces/:workspaceId/integrations/microsoft/connect` | ADMIN |
| GET | `/api/v1/integrations/microsoft/callback` | Public (state) |
| GET | `/api/v1/workspaces/:workspaceId/integrations/:connectionId/microsoft/todo-lists` | MEMBER |

## Database Changes

None new; `IntegrationCredential` holds encrypted access/refresh tokens + `accessTokenExpiresAt`; `OAuthState` holds encrypted PKCE verifier.

## Security Requirements

- PKCE + state; state single-use and bound to user/workspace/provider.
- Refresh token encrypted; rotated token persisted in the same transaction that marks refresh success.
- Tokens never logged; Graph request IDs (`request-id`, `client-request-id`) logged for diagnostics instead.
- Connection is per-user delegated access: document that workflows act as the connecting user.

## Testing Requirements

- Unit (HTTP mocked): authorize URL composition (scopes, PKCE), token exchange, refresh-before-expiry, refresh rotation persistence, `invalid_grant`, 429 with Retry-After, 401 from Graph → one forced refresh then `PROVIDER_AUTH`.
- Integration: callback flows (good/bad/reused state), concurrent refresh serialisation (two jobs, one refresh call).
- Manual: real account creates a task (evidence recorded).

## Deliverables

Microsoft provider module, Graph client, token manager, handler, tests, Entra registration guide.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-14.1 | Authorization flow completes and stores encrypted tokens | Integration + manual |
| AC-14.2 | Only the listed delegated scopes are requested | Unit asserting URL |
| AC-14.3 | Expiring token refreshed and rotated refresh token persisted | Unit + integration |
| AC-14.4 | Revoked consent → NEEDS_ATTENTION + PROVIDER_AUTH | Unit/integration |
| AC-14.5 | Task created by workflow action | Mocked integration + manual real run |
| AC-14.6 | Throttling honoured | Unit |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Mail, Teams, calendar, OneDrive, application permissions, Graph change-notification triggers.

## Dependencies

Parts 08, 11, 17.

## Risks / Design Questions

- **Alternative action:** calendar event creation supports an idempotency-like `transactionId`, which would give a stronger duplicate guarantee, but requires `Calendars.ReadWrite` (more sensitive data). To Do chosen for lower data sensitivity; trade-off documented in Part 15.
- Personal Microsoft accounts and some tenants may block user consent; documented in troubleshooting.

## Implementation Notes

Replaces scaffold `MicrosoftProvider` stub.
