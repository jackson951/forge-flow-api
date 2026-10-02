# 13 — Slack Integration

**Status:** COMPLETE (2026-10-02) — all criteria verified, including a real Slack workspace (evidence below); see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Connect a Slack workspace via OAuth and provide a `slack.sendMessage` action, completing the flagship workflow:

```
GitHub Issue Created → AI Classify → Priority HIGH? ── yes ──▶ Slack Message
                                                     └─ no ──▶ (end)
```

## Why This Part Exists

It is the first integration with an external side effect that users will notice if duplicated, making it the proving ground for retry classification and Part 15's guarantees.

## Scope

Slack OAuth v2 connection, encrypted bot-token storage, team metadata, channel listing, send-message handler, rate-limit/revocation handling.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-13.1 | ADMIN starts connect → Slack authorize URL with `state` (single-use, 10 min). |
| FR-13.2 | Callback verifies `state`, exchanges code (`oauth.v2.access`), stores encrypted bot token, `team.id`, `team.name`, bot user ID, granted scopes. |
| FR-13.3 | Re-connecting the same Slack team in the same workspace updates the existing connection. |
| FR-13.4 | `GET …/slack/channels` lists public channels (and private ones the bot is in), paginated, names + IDs only. |
| FR-13.5 | `slack.sendMessage` config `{ connectionId, channelId, text (template, ≤ 3 000 chars) }` → output `{ channelId, ts }`. |
| FR-13.6 | `invalid_auth`, `token_revoked`, `account_inactive` → step `PROVIDER_AUTH` (permanent), connection `NEEDS_ATTENTION`. |
| FR-13.7 | `not_in_channel`, `channel_not_found` → `PERMANENT_PROVIDER_ERROR` with actionable message. |
| FR-13.8 | HTTP 429 → `PROVIDER_RATE_LIMIT`, retry after `Retry-After`. 5xx/network → `TRANSIENT_INFRASTRUCTURE`/`PROVIDER_TIMEOUT` (retryable, subject to Part 15). |
| FR-13.9 | Disconnect calls `auth.revoke` best-effort and deletes stored credentials. |

## Technical Requirements

- Scopes: `chat:write`, `channels:read`, `groups:read` (only if private-channel listing is kept). No user-token scopes.
- Plain `fetch` client or `@slack/web-api` with its built-in retries **disabled** (FlowForge owns retry policy).
- `sideEffect: 'non-idempotent'` — Slack has no idempotency key for `chat.postMessage` (see Part 15).
- Store message `ts` in `StepRun.externalRef` immediately after success.
- Timeout 10 s.
- Token rotation (Slack's optional expiring tokens) not enabled; documented.

## API Changes

| Method | Path | Min role |
| --- | --- | --- |
| POST | `/api/v1/workspaces/:workspaceId/integrations/slack/connect` | ADMIN |
| GET | `/api/v1/integrations/slack/callback` | Public (state) |
| GET | `/api/v1/workspaces/:workspaceId/integrations/:connectionId/slack/channels` | MEMBER |
| DELETE | `/api/v1/workspaces/:workspaceId/integrations/:connectionId` | ADMIN (shared, Part 17) |

## Database Changes

None new (`IntegrationConnection`, `IntegrationCredential`, `OAuthState`).

## Security Requirements

- Client secret from config; bot token encrypted at rest, decrypted only in worker handler scope.
- Channel listing returns only IDs/names.
- Message text comes from templates; `<!channel>`/`<!here>` mentions are escaped by default (`allowBroadcastMentions: false`) to prevent abuse via issue titles.

## Testing Requirements

- Unit (HTTP mocked): success; each error code mapping; 429 with Retry-After; timeout; mention escaping.
- Integration: OAuth callback happy path + bad state + reused state; stored credential is ciphertext; channel list scoped to workspace; flagship workflow executes end-to-end with GitHub fixture webhook, fake AI returning HIGH (Slack called once) and LOW (Slack not called).
- Manual: real Slack workspace message delivered (evidence recorded).

## Deliverables

Slack provider module (connect/callback, client, handler, channel listing), tests, setup guide (creating the Slack app) in this document.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-13.1 | Flagship workflow executes: HIGH → one Slack message; LOW → none | Integration with mocked Slack + manual real run |
| AC-13.2 | OAuth connection stores encrypted token and team metadata | Integration |
| AC-13.3 | Rate limit handled with delayed retry | Unit |
| AC-13.4 | Revoked token → PROVIDER_AUTH, connection NEEDS_ATTENTION | Integration |
| AC-13.5 | Retry classification per FR-13.6–13.8 | Unit |
| AC-13.6 | Token never in responses/logs | Scan tests |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Slack triggers (Events API), Block Kit builder, DMs, file uploads, interactive messages.

## Dependencies

Parts 08, 11, 17 (encryption); flagship AC depends on 10 and 12.

## Risks / Design Questions

- **Duplicate messages on crash** between Slack success and DB write are possible; Part 15 defines the policy (fail as `UNCERTAIN_OUTCOME` rather than blindly resend).

## Implementation Notes

Replaces scaffold `SlackProvider` stub.

## Setup guide: creating the Slack app

1. https://api.slack.com/apps → **Create New App** → From scratch; pick a development workspace.
2. **OAuth & Permissions → Redirect URLs:** `<OAUTH_REDIRECT_BASE_URL>/slack/callback`, e.g. `https://<tunnel>/api/v1/integrations/slack/callback`. Slack requires HTTPS, so local development needs a tunnel (`ngrok http 3000`). Click **Save URLs**.
3. **Bot Token Scopes:** `chat:write`, `channels:read`, `groups:read`. No user scopes. Leave **Token Rotation** off (not supported; expiring tokens are out of scope).
4. **Basic Information:** copy Client ID and Client Secret.
5. `.env` (never commit it):
   ```
   SLACK_CLIENT_ID=…
   SLACK_CLIENT_SECRET=…
   OAUTH_REDIRECT_BASE_URL=https://<tunnel>/api/v1/integrations
   ENCRYPTION_KEYS=dev1:<base64 of 32 random bytes>   # tokens are stored encrypted (Part 17)
   ENCRYPTION_ACTIVE_KEY_ID=dev1
   ```
   Slack shows as configured (`GET /integrations/providers`) only when all of these are set.
6. As a workspace ADMIN: `POST /api/v1/workspaces/:id/integrations/SLACK/connect` → open the URL → **Allow**. Then `/invite @<app>` in the channel to post to and use its id from `GET …/integrations/:connectionId/slack/channels`.

## Implementation decisions

| Question | Decision |
| --- | --- |
| Client | Plain `fetch` (no `@slack/web-api`), form-encoded bodies (accepted by every method; `oauth.v2.access` and read methods reject JSON), 10 s timeout, no client-side retries |
| Token exchange | `oauth.v2.access` with HTTP Basic client credentials; only workspace bot tokens accepted (enterprise-wide installs refused) |
| Credential persistence | Providers may return a `credential` with the completed connection; `IntegrationsService` saves it encrypted via `CredentialStore` in the same transaction as the connection upsert. Re-connecting the same team replaces the token and sets the status back to CONNECTED |
| Worker credential access | `WorkerConnections` (worker only) decrypts the token for a CONNECTED connection of the right provider **in the run's workspace**; anything else → `PROVIDER_AUTH`. Handlers never get the store itself |
| Mention escaping | `<!channel>`, `<!here>`, `<!everyone>` and `<!subteam^…>` are HTML-escaped (shown as text, no notification) unless `allowBroadcastMentions: true`; messages are posted with `parse=none`, `link_names=false`. User mentions and links (`<@U…>`, `<url|label>`) are left as written |
| Text length | Template ≤ 3 000 characters (validated on publish); rendered text above 3 000 is truncated with "…" and the output records `truncated: true` |
| Timeouts | A timeout during `chat.postMessage` is `UNCERTAIN_OUTCOME` (permanent) rather than retried — Slack may have posted it (stricter than FR-13.8, consistent with the engine's rule for non-idempotent steps, Part 15). Timeouts on reads are retryable `PROVIDER_TIMEOUT` |
| Delayed retry | **Engine-wide change:** run jobs now use a custom BullMQ backoff (`src/infrastructure/queue/retry-backoff.ts`): a provider's `Retry-After` (`retryAfterMs` on rate-limit errors) sets the delay; otherwise exponential with ±30 % jitter; capped at 15 min. Before this, `retryAfterMs` was carried but ignored (also affected GitHub rate limits) |
| Redirect base | `OAUTH_REDIRECT_BASE_URL` is the base of `/api/v1/integrations`; `.env.example` previously showed `/api/integrations` (missing `v1`), corrected |

### Error classification

| Slack answer | Category | Retry | Connection |
| --- | --- | --- | --- |
| `invalid_auth`, `not_authed`, `token_revoked`, `token_expired`, `account_inactive`, `missing_scope`, `no_permission`, … | `PROVIDER_AUTH` | no | NEEDS_ATTENTION |
| `not_in_channel`, `channel_not_found`, `is_archived`, `msg_too_long`, `restricted_action` | `PERMANENT_PROVIDER_ERROR` with how to fix it | no | — |
| HTTP 429 / `ratelimited` | `PROVIDER_RATE_LIMIT`, delay from `Retry-After` (default 30 s) | yes | — |
| HTTP 5xx, `internal_error`, `fatal_error`, `service_unavailable`, `request_timeout`, network failure | `TRANSIENT_INFRASTRUCTURE` | yes | — |
| Timeout while posting | `UNCERTAIN_OUTCOME` | no | — |
| Anything else | `PERMANENT_PROVIDER_ERROR` (`Slack error: <code>`; unexpected strings are never echoed) | no | — |

## Implementation Evidence

Verified 2026-10-02 on branch `feat/part-13-slack` (stacked on `feat/part-10-github-live`).

### What was implemented

| Item | Location |
| --- | --- |
| Slack client: authorize URL, `oauth.v2.access`, `chat.postMessage`, `conversations.list`, `auth.revoke`; error mapping | `src/modules/integrations/slack/slack-client.ts` |
| Connection provider (connect, callback exchange, revoke on disconnect) | `src/modules/integrations/providers/slack.provider.ts` |
| Credential saved with the connection | `integration-provider.interface.ts` (`CompletedConnection`), `integrations.service.ts` |
| `GET /api/v1/workspaces/:workspaceId/integrations/:connectionId/slack/channels` (MEMBER; ids, names, `isPrivate`; Slack cursor) | `integrations.controller.ts`, `integrations.service.ts`, `dto/slack-channels-query.dto.ts` |
| `slack.sendMessage` node type and non-idempotent handler (externalRef = `ts`) | `src/modules/integrations/slack/slack.node-types.ts` |
| Worker-side, workspace-scoped token access | `src/execution/worker-connections.ts`, `execution.module.ts` |
| Provider `Retry-After` honoured by the run queue | `src/infrastructure/queue/retry-backoff.ts`, `run-queue.service.ts`, `execution/processors.ts` |
| Config: `SLACK_API_URL`, `SLACK_OAUTH_URL` | `src/config/env.schema.ts`, `.env.example` |
| Tests: fake Slack server; worker accepts config overrides | `test/support/fake-slack.ts`, `test/support/create-worker.ts` |

### Command results

| Command | Result |
| --- | --- |
| prettier check, lint (0 warnings), typecheck, build | pass |
| `npm test` | 475 passed (31 in `slack.spec.ts`, incl. retry delay) |
| `npm run test:e2e` | 16 passed |
| `npm run test:int` | 225 passed (14 in `slack.int-spec.ts`) |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-13.1 | PASS | Integration (fake Slack, real worker): signed GitHub `issues.opened` → `ai.classify` (fake AI) → condition → `slack.sendMessage`: HIGH → exactly one message (broadcast mention from the title escaped), `ts` stored as `externalRef`; LOW → step SKIPPED, no message. **Live:** see below |
| AC-13.2 | PASS | Integration: callback stores `externalAccountId` = team id, team name, bot user id, granted scopes; credential column is `v1.test1.…` ciphertext, plaintext absent; bad/reused state, `access_denied` and a rejected code all redirect with a generic reason; re-connect updates the same connection |
| AC-13.3 | PASS | Unit: 429 `Retry-After: 7` → `retryAfterMs` 7000 and the queue delay is 7000. Integration: 429 with `Retry-After: 1` then success → second `chat.postMessage` ≥ 950 ms later (test backoff is 50 ms), one message, `attemptCount` 2 |
| AC-13.4 | PASS | Integration: revoked token → run FAILED, step `PROVIDER_AUTH` ("reconnect Slack"), no message, connection NEEDS_ATTENTION, channel listing 409; reconnecting restores CONNECTED and the next run posts |
| AC-13.5 | PASS | Unit: auth errors, `not_in_channel`/`channel_not_found` (actionable), `ratelimited`, transient codes, unknown codes, HTTP 429/5xx, network failure, timeout (post vs. read). Integration: `not_in_channel` fails after 1 attempt with the `/invite` hint |
| AC-13.6 | PASS | Integration: every response, every `PinoLogger` call and all stored step rows scanned — no bot token, client secret or OAuth code. Unit: errors never contain the token; handler logs only channel id and length. Live scan below |

Also verified: FR-13.4 channel listing scoped to workspace and provider (other workspace, non-member and a GitHub connection id → 404); FR-13.9 disconnect calls `auth.revoke`, deletes the credential, audits `revokedAtProvider: true`.

**Mutation checks** (each made the integration tests fail, then reverted): ignoring `Retry-After` in the backoff; not marking the connection NEEDS_ATTENTION; not escaping broadcast mentions.

## Live verification (2026-10-02)

Real Slack app (workspace "Forge Flow"), real GitHub App from Part 10, ngrok tunnel to a local API and worker (`node dist/main`, `node dist/worker`), `AI_PROVIDER=fake`, dev database.

| Step | Result |
| --- | --- |
| Connect | Authorize URL with the three bot scopes and the HTTPS redirect URI; Slack redirected with `code` and `state`; the callback was completed against the local API (the browser stopped at ngrok's interstitial page) → 302 `status=connected`; connection `13f875dd-…` CONNECTED, team `T0C628MCWKF` "Forge Flow", bot user `U0C72L6KY5N`, scopes `chat:write, channels:read, groups:read`; credential stored as `v1.dev1.…` |
| Channels | `GET …/slack/channels` → `all-forge-flow`, `social`, `new-channel` (ids and names only) |
| HIGH | GitHub issue #14 "Checkout is down HIGH" → run `733b4388-79b6-48a5-9ef6-09ce285575e0` SUCCEEDED: classify HIGH → condition true → Slack accepted the message in `#all-forge-flow`, `ts` `1790933939.448899` stored as externalRef |
| LOW | GitHub issue #15 "Typo in README LOW" → run `5547bb35-78c0-4305-aca7-ccfe2e251701` SUCCEEDED: classify LOW → condition false → Slack step SKIPPED |
| Secrets | API + worker logs: no `xoxb-`/`xoxe-` token, no client secret; the OAuth code appears only as `code=[REDACTED]`; no token in any step row |

### Notes / follow-ups

- The live classification used the deterministic fake AI provider (no API key in this environment); a run with `AI_PROVIDER=anthropic` is still recommended (Part 12 note).
- Duplicate-message risk after a crash between Slack's success and the database write is handled by the existing engine rule (`UNCERTAIN_OUTCOME`); Part 15 owns the full policy.
- Token rotation (expiring Slack tokens) is not supported; keep it disabled in the Slack app.
