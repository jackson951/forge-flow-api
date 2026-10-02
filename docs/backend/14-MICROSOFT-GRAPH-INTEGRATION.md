# 14 — Microsoft Graph Integration

**Status:** BLOCKED (2026-10-02) — implemented; all criteria verified with a simulated Microsoft and the live connect/refresh flow verified with a real Entra app. **Blocked on the manual part of AC-14.5:** creating a real task needs an account that has Microsoft To Do (the connected test account is a guest without a mailbox). See [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

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

## Setup guide: registering the Entra app

1. https://entra.microsoft.com → **App registrations → New registration**.
2. **Supported account types:** "Accounts in any organizational directory and personal Microsoft accounts" for `MICROSOFT_TENANT_ID=common`. To restrict to one organisation, choose single tenant and set `MICROSOFT_TENANT_ID` to the tenant id or domain (`organizations` = any work/school account, `consumers` = personal accounts only).
3. **Redirect URI:** platform **Web**, `<OAUTH_REDIRECT_BASE_URL>/microsoft/callback`, e.g. `https://<tunnel>/api/v1/integrations/microsoft/callback` (Entra also accepts `http://localhost…` for development).
4. **Certificates & secrets → New client secret.** Copy the **Value** (shown once), not the Secret ID. Note the expiry: an expired secret makes every refresh fail with `invalid_client` (reported as a server error; connections are not flagged).
5. **API permissions → Microsoft Graph → Delegated:** `User.Read`, `Tasks.ReadWrite` (`openid`, `profile`, `offline_access` are implicit). **Remove anything else** — Microsoft includes every permission consented on the app in issued tokens, even if FlowForge did not request it. No application permissions, no admin consent needed.
6. `.env` (never commit it):
   ```
   MICROSOFT_CLIENT_ID=<Application (client) ID>
   MICROSOFT_CLIENT_SECRET=<secret Value>
   MICROSOFT_TENANT_ID=common
   OAUTH_REDIRECT_BASE_URL=https://<tunnel>/api/v1/integrations
   ENCRYPTION_KEYS=dev1:<base64 of 32 random bytes>
   ENCRYPTION_ACTIVE_KEY_ID=dev1
   ```
7. As a workspace ADMIN: `POST /api/v1/workspaces/:id/integrations/MICROSOFT/connect` → open the URL → sign in and consent. Workflows using the connection **act as that user**.

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| Callback redirects with `reason=provider_error`; log `Integration connection failed` with `detail: … (invalid_client)` | Wrong client secret (Secret ID instead of Value) or expired secret |
| `reason=not_authorized` | Consent did not include `Tasks.ReadWrite` or offline access (tenant blocks user consent, or the permission is missing on the app) |
| To Do calls fail with "cannot use Microsoft To Do … Exchange Online mailbox" (422 / step `PERMANENT_PROVIDER_ERROR`) | The account has no To Do: guest (`#EXT#`) users and unlicensed work accounts. Use a licensed Microsoft 365 account or a personal Microsoft account |
| Connection `NEEDS_ATTENTION` | Consent revoked, password reset or refresh token expired (`invalid_grant`), or Graph returned 403. Reconnect |

## Implementation decisions

| Question | Decision |
| --- | --- |
| Client | Plain `fetch` (`MicrosoftClient`), no MSAL: FlowForge stores and refreshes tokens itself (encrypted, Part 17). v2 endpoints `{MICROSOFT_LOGIN_URL}/{tenant}/oauth2/v2.0/authorize|token`, Graph `{MICROSOFT_GRAPH_URL}` (defaults: login.microsoftonline.com, graph.microsoft.com/v1.0). 15 s timeouts |
| PKCE | Generic in the shared connect flow (`IntegrationProvider.usesPkce`): 32-byte verifier, S256 challenge in the authorize URL, verifier stored encrypted in `OAuthState.encryptedCodeVerifier` with AAD bound to the state hash, decrypted only on the callback |
| Account identity | `externalAccountId` = Graph `/me` id (authenticated by the token). The id_token is decoded **unverified** for display metadata only (`tenantId`) |
| Consent check | The connection is refused (`not_authorized`) unless the granted scopes include `Tasks.ReadWrite` and a refresh token was issued |
| Refresh | `MicrosoftTokenManager`: refresh when < 5 min remain; inside a transaction holding `SELECT … FOR UPDATE` on the credential row (serialises API and worker processes); re-reads after acquiring the lock and reuses a token another process just stored; saves the rotated refresh token (or keeps the old one if Microsoft did not rotate) and the new expiry in the same transaction |
| Auth failures | Refresh `invalid_grant` / `interaction_required` / `consent_required` → connection NEEDS_ATTENTION + `PROVIDER_AUTH`. `invalid_client` / `unauthorized_client` → `PROVIDER_AUTH` without flagging (FlowForge's app registration; API returns 503). Graph 401 → one forced refresh and retry; 401 again after that fresh token → `PERMANENT_PROVIDER_ERROR` "cannot use Microsoft To Do", connection not flagged (found during live verification). Graph 403 → NEEDS_ATTENTION + `PROVIDER_AUTH` |
| Throttling | Graph 429, and 503 with `Retry-After` → `PROVIDER_RATE_LIMIT` with that delay (queue honours it, Part 13 backoff); token endpoint 429 likewise; 5xx → retryable |
| Paging | `@odata.nextLink` followed only if it starts with the configured Graph base URL (a bearer token must never go to another host); at most 10 pages |
| Task creation | `microsoft.todo.createTask` is non-idempotent (no idempotency key in To Do); task id = `externalRef`; a timeout while creating is `UNCERTAIN_OUTCOME`. Title ≤ 255 and body ≤ 4 000 (rendered text truncated with "…", flagged in the output); `dueDate` must render to `YYYY-MM-DD` (an ISO date-time is cut to its date; empty → no due date; invalid → `VALIDATION`) |
| Revocation on disconnect | No per-app revocation endpoint for delegated tokens: disconnect deletes the stored tokens; users remove consent at myapps.microsoft.com / account.live.com/consent/Manage |
| API errors for provider calls | Permanent provider errors now return **422** with the safe message (previously 503 with a hidden message); retryable ones 503. Applies to GitHub repositories and Slack channels as well |
| Callback diagnostics | The `Integration connection failed` log now includes the safe detail (provider error code), e.g. `invalid_client`; the browser still gets only `reason` |

## Implementation Evidence

Verified 2026-10-02 on branch `feat/part-14-microsoft-graph` (from `main` at `5255ed5`).

### What was implemented

| Item | Location |
| --- | --- |
| Microsoft identity + Graph client, error mapping, id_token display claims | `src/modules/integrations/microsoft/microsoft-client.ts` |
| Token manager (refresh, row lock, rotation, 401 retry, flagging rules) | `src/modules/integrations/microsoft/microsoft-token-manager.ts` |
| Locked credential read | `CredentialStore.getLocked` in `credentials/credential-store.ts` |
| Provider (PKCE, consent check, profile) | `src/modules/integrations/providers/microsoft.provider.ts` |
| PKCE in the shared connect flow | `integration-provider.interface.ts`, `integrations.service.ts` |
| `GET /api/v1/workspaces/:workspaceId/integrations/:connectionId/microsoft/todo-lists` (MEMBER) | `integrations.controller.ts`, `integrations.service.ts` |
| `microsoft.todo.createTask` node type and handler | `src/modules/integrations/microsoft/microsoft.node-types.ts` |
| Worker and catalog wiring | `execution.module.ts`, `engine.module.ts` |
| Config: `MICROSOFT_LOGIN_URL`, `MICROSOFT_GRAPH_URL`, validated `MICROSOFT_TENANT_ID` | `src/config/env.schema.ts` |
| Tests: fake Microsoft identity + Graph server (PKCE verification, rotating refresh tokens, scripted failures) | `test/support/fake-microsoft.ts` |
| Test setup always uses its own random encryption key (a developer's `.env` key was being picked up) | `test/setup-env.ts`, `test/setup-int-env.ts` |

### Command results

| Command | Result |
| --- | --- |
| prettier check, lint (0 warnings), typecheck, build | pass |
| `npm test` | 506 passed (31 in `microsoft.spec.ts`) |
| `npm run test:e2e` | 16 passed |
| `npm run test:int` | 243 passed (18 in `microsoft.int-spec.ts`) |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-14.1 | PASS | Integration: connect URL with state + S256 challenge; verifier stored only as `v1.…` ciphertext; callback exchanges the code with the verifier (the fake checks `sha256(verifier) = challenge`), stores encrypted access + refresh tokens, expiry, Graph user id, UPN, display name and tenant id; bad/reused state, `access_denied`, a code issued for another challenge, and partial consent are refused. **Live:** completed with a real Entra app (below) |
| AC-14.2 | PASS | Unit + integration assert the exact scope string `openid profile offline_access User.Read Tasks.ReadWrite` and no Mail/Files/Calendars/`.default` |
| AC-14.3 | PASS | Integration: token expiring in 1 min → one refresh with the stored refresh token, the rotated refresh token and new expiry persisted; four concurrent requests from the API and worker token managers → exactly one refresh call, same token; 401 with a not-yet-expired token → one forced refresh and success. Live: a forced refresh against Microsoft succeeded and was stored |
| AC-14.4 | PASS | Integration: `invalid_grant` → run FAILED, step `PROVIDER_AUTH` ("reconnect Microsoft"), no task, connection NEEDS_ATTENTION, lists 409; reconnecting the same account restores it. `invalid_client` → 503, connection stays CONNECTED |
| AC-14.5 | **BLOCKED (manual part)** | Integration: manual trigger → `microsoft.todo.createTask` creates the task with rendered title/body/due date in the chosen list, task id as `externalRef`; invalid due date fails before any Graph call; persistent 401 → `PERMANENT_PROVIDER_ERROR` without flagging. **Live task creation not yet done:** the connected account (a guest user in the test tenant) has no To Do mailbox — Graph returns 401 `UnknownError` for To Do while `/me` succeeds |
| AC-14.6 | PASS | Unit: Graph 429 / 503 with `Retry-After` → `PROVIDER_RATE_LIMIT` with that delay, and the queue delay equals it. Integration: 429 `Retry-After: 1` → retry ≥ 950 ms later, one task, `attemptCount` 2 |

Also verified: To Do lists across two pages; a paging link to another host is refused (422) and never requested; lists scoped to the workspace (404 for other workspaces and non-members); disconnect deletes the tokens; responses, every `PinoLogger` call and stored step rows contain no access token, refresh token or client secret.

**Mutation checks** (each made the integration tests fail, then reverted): removing the row lock (concurrent refresh test); keeping the old refresh token instead of the rotated one; not forcing a refresh on a 401.

## Live verification (2026-10-02)

Real Entra app (tenant `common`), ngrok tunnel, local API and worker, dev database.

| Step | Result |
| --- | --- |
| Connect | Authorize URL with the five scopes and S256 challenge; consent; callback → `status=connected`; connection `b1812ea8-…` CONNECTED, Graph user id `419e9d1a-…`, tenant `ffc9c9ea-…`, tokens stored as ciphertext |
| Finding: extra scopes | The issued token also carried `Calendars.ReadWrite(.Shared)` and `Mail.Send(.Shared)` because they are configured on the test app registration (Microsoft returns all consented permissions). FlowForge requests only the five; the setup guide now says to remove other permissions from the app |
| First attempt | Failed with `reason=provider_error` and no logged cause → the callback log now includes the safe detail |
| To Do lists | Graph `/me` 200, `/me/todo/lists` 401 `UnknownError` (guest account without mailbox). Before the fix FlowForge flagged the connection NEEDS_ATTENTION and answered "access was revoked" (wrong: reconnecting cannot help). After the fix: forced refresh against Microsoft succeeded, retry still 401 → 422 "cannot use Microsoft To Do … Exchange Online mailbox" with Graph's request-id; connection stays CONNECTED |
| Task creation | **Pending** — reconnect with an account that has To Do (a personal Microsoft account such as outlook.com, or a licensed Microsoft 365 work account), then run a workflow with `microsoft.todo.createTask` |

### Found and fixed during this part

- **401 after a fresh token was treated as lost consent** (live): now an account limitation (`PERMANENT_PROVIDER_ERROR`, connection untouched).
- **Callback failures were undiagnosable** (live): safe detail now logged.
- **Provider errors on API listing calls were opaque 503s:** permanent ones are now 422 with the message.
- **Tests used a developer's encryption key from `.env`:** test setup now forces its own key.
