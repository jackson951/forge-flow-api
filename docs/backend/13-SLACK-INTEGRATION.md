# 13 — Slack Integration

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

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
