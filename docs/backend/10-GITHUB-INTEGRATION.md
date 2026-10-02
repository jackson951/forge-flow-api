# 10 — GitHub Integration

**Status:** BLOCKED (2026-10-02) — everything implemented and verified except AC-10.1 (a real event from github.com), which needs a registered GitHub App. See the setup guide below; see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Deliver the first real integration: connect a GitHub account/repositories to a workspace and trigger published workflows when an issue is opened.

```
GitHub ─ issue opened ─▶ POST /api/v1/webhooks/github ─▶ verify signature ─▶ dedupe X-GitHub-Delivery
       ─▶ match WorkflowTrigger (installation + repo) ─▶ create run ─▶ queue ─▶ worker
```

## Why This Part Exists

It proves the webhook platform, credential model and engine against a real provider with real signatures, retries and rate limits.

## Scope

GitHub App based connection, installation callback, credential handling, webhook verification and normalisation, `github.issue.created` trigger node, optional `github.issue.addComment` action (only if needed for the demo flow), rate-limit and revoked-installation handling.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-10.1 | ADMIN starts a connection; API returns the GitHub App installation URL with a single-use `state`. |
| FR-10.2 | The setup callback verifies `state`, verifies the installation belongs to the authorising user (via user-to-server OAuth code), and stores an `IntegrationConnection` with `externalAccountId = installation_id` and the account login. |
| FR-10.3 | The connection lists accessible repositories for trigger configuration (`GET .../connections/:id/github/repositories`). |
| FR-10.4 | `github.issue.created` trigger config: `{ connectionId, repository: "owner/name" }`; publish writes `WorkflowTrigger(provider=GITHUB, eventType=issues.opened, resourceKey=installationId:owner/name)`. |
| FR-10.5 | `issues` webhook with `action=opened` is normalised to `{ issue: { number, title, body, url, labels[], author }, repository: { fullName }, sender: { login } }`; other actions are `IGNORED`. |
| FR-10.6 | `installation` `deleted`/`suspend` events mark the connection `DISCONNECTED`/`NEEDS_ATTENTION`. |
| FR-10.7 | If an action is included, it uses an installation access token and handles 401/403/404/rate-limit responses with the correct error categories. |

## Technical Requirements

- **GitHub App, not OAuth App** (decision): fine-grained permissions (Issues: read [write only if the comment action ships], Metadata: read), one app-level webhook secret, per-installation delivery, and short-lived installation tokens minted on demand from the app private key — so FlowForge stores **no long-lived user tokens**. The user-to-server token obtained during installation is used once to verify ownership and discarded.
- Config: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM, base64 in env), `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_SLUG`.
- Signature: HMAC-SHA256 of raw body with webhook secret, header `X-Hub-Signature-256`, constant-time compare.
- Delivery ID: `X-GitHub-Delivery`; event type `X-GitHub-Event` + `action`.
- Installation tokens cached in memory until 5 min before expiry (never persisted, never logged).
- Rate limits: honour `Retry-After` and `x-ratelimit-reset`; classify as `PROVIDER_RATE_LIMIT` (retryable with delay). 401 → `PROVIDER_AUTH` (permanent, mark connection `NEEDS_ATTENTION`).
- Use `@octokit/rest` + `@octokit/auth-app` or plain `fetch` with a small client — decision at implementation; either way wrapped in `GitHubClient`.

## API Changes

| Method | Path | Min role |
| --- | --- | --- |
| POST | `/api/v1/workspaces/:workspaceId/integrations/github/connect` | ADMIN → `{ url }` |
| GET | `/api/v1/integrations/github/callback` | Public (state-authenticated) → `302` to `FRONTEND_URL/integrations?provider=github&status=connected&connectionId=…` or `status=error&reason=invalid_state|denied|not_authorized|provider_error` |
| GET | `/api/v1/integrations/providers` | authenticated → `[{ key, configured }]` |
| GET | `/api/v1/workspaces/:workspaceId/integrations` | MEMBER → connections (metadata only) |
| DELETE | `/api/v1/workspaces/:workspaceId/integrations/:connectionId` | ADMIN → unbind (triggers stop matching) |
| GET | `/api/v1/workspaces/:workspaceId/integrations/:connectionId/github/repositories` | MEMBER |
| POST | `/api/v1/webhooks/github` | Signature |

## Database Changes

None new; uses `IntegrationConnection` (`provider=GITHUB`, metadata JSON with account login/type), `OAuthState`, `WebhookDelivery`, `WorkflowTrigger`.

## Security Requirements

- App private key and webhook secret only from environment/secret manager.
- Installation-to-workspace binding verified; an installation already bound to another workspace is rejected unless re-authorised by a member of that installation.
- Webhook payloads from installations not bound to any workspace are `IGNORED`.
- No GitHub tokens in responses, logs or DB.

## Testing Requirements

- Unit: signature verification with GitHub's documented test vector; normaliser with recorded fixtures (`issues.opened`, `issues.edited`, `installation.deleted`); error classification.
- Integration: signed fixture webhook → run created; tampered body → 401; same `X-GitHub-Delivery` twice → one run; callback with bad/expired/reused state → rejected; GitHub HTTP mocked (nock/msw).
- Manual (documented with evidence): real GitHub App on a test repository opening an issue triggers a published workflow (via a tunnel such as smee.io or ngrok).

## Deliverables

GitHub provider module (connection service, callback handler, webhook adapter, client, trigger node definition), fixtures, tests, setup guide (creating the GitHub App) in this document.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-10.1 | Real GitHub issue event triggers published workflow | Manual run with recorded run ID/log excerpt |
| AC-10.2 | Invalid signature rejected | Integration |
| AC-10.3 | Duplicate GitHub delivery doesn't duplicate run | Integration |
| AC-10.4 | Secrets/tokens absent from responses and logs | Integration (response scan) + log capture test |
| AC-10.5 | Revoked installation marks connection and fails runs with PROVIDER_AUTH | Integration |
| AC-10.6 | Rate-limit response classified retryable with delay | Unit |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Pull request, push or comment triggers; GitHub Enterprise Server; creating repos/webhooks programmatically.

## Dependencies

Parts 09, 17 (encryption service at minimum; this part stores no tokens, but OAuth state handling uses it).

## Risks / Design Questions

- **OAuth App alternative:** would require `repo`/`admin:repo_hook` scopes and storing long-lived user tokens — broader and riskier; rejected.
- **Local development** needs a public URL for webhooks; documented tunnel setup.

## Implementation Notes

The scaffold's `GitHubProvider` OAuth interface (`exchangeCode`/`refresh`) does not fit a GitHub App; the provider contract becomes capability-based (connect flow, webhook adapter, credential resolver).

## Setup guide: creating the GitHub App

1. GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. **Name:** unique, e.g. `FlowForge Dev <you>`. **Homepage URL:** `http://localhost:5173`.
3. **Callback URL:** `http://localhost:3000/api/v1/integrations/github/callback`. Tick **Request user authorization (OAuth) during installation**. (The Setup URL is then not used.)
4. **Webhook:** Active. **URL:** `<public tunnel URL>/api/v1/webhooks/github`. **Secret:** random, 32+ characters (`openssl rand -hex 32`).
5. **Repository permissions:** Issues → *Read-only*; Metadata → *Read-only*. Nothing else.
6. **Subscribe to events:** Issues.
7. **Where can this app be installed:** Only on this account. Create the app.
8. On the app page: note **App ID**, **Client ID**, the app **slug** (from its URL); **Generate a new client secret**; **Generate a private key** (downloads a `.pem`).
9. `.env` (never commit it or the `.pem`):
   ```
   GITHUB_APP_ID=…
   GITHUB_APP_SLUG=…
   GITHUB_CLIENT_ID=…
   GITHUB_CLIENT_SECRET=…
   GITHUB_WEBHOOK_SECRET=…          # the secret from step 4
   GITHUB_APP_PRIVATE_KEY=…         # base64 -w0 your-app.private-key.pem
   ```
10. Public URL for local development: `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000` (both forward the body unchanged, which signature verification requires). Put the tunnel URL into the app's webhook URL.
11. Run Postgres and Redis, `npm run start:dev` **and** `npm run worker:dev`. As a workspace ADMIN: `POST /api/v1/workspaces/:id/integrations/GITHUB/connect`, open the returned URL, install the app on a test repository. Then publish a workflow whose trigger is `github.issue.created` with that `connectionId` and `repository`, and open an issue in the repository.

## Implementation Evidence

Verified 2026-10-02 on branch `feat/part-11-09-conditions-and-webhooks` (together with Parts 11 and 09).

### What was implemented

| Item | Location |
| --- | --- |
| GitHub client without SDK: RS256 app JWT, installation tokens cached in memory (never persisted), user-code exchange, installations, repositories; 10 s timeouts; error mapping (rate limits incl. secondary/`x-ratelimit-reset`, auth, 5xx) | `src/modules/integrations/github/github-client.ts` |
| Webhook adapter: `X-Hub-Signature-256` over the raw body, `X-GitHub-Delivery` dedup key, `issues.opened` normalisation (case-insensitive repo key, capped body), `installation` deleted/suspend/unsuspend → connection status | `github-webhook.provider.ts` |
| Trigger node type `github.issue.created` (`connectionId`, `repository`), routing `issues.opened` + repository + connection | `github.node-types.ts` |
| Connect flow: single-use hashed `state` (10 min), install redirect, callback verifies state, ADMIN still a member, user can access the installation; upsert connection; audit `integration.connected/disconnected`; redirects to the frontend with a generic status only | `integrations.service.ts`, `providers/github.provider.ts`, `integrations.controller.ts` |
| Generic webhook additions: `accountId` binding (event must come from the trigger's CONNECTED connection in the same workspace) and `connectionStatus` updates | `src/modules/webhooks/*` |
| **Publish-time connection check** (`CONNECTION_INVALID`): a node's `connectionId` must be a CONNECTED connection of the right provider in the workflow's own workspace | `src/modules/workflows/publishing.service.ts`, `NodeTypeDefinition.connectionProvider` |
| Config: `GITHUB_APP_ID/SLUG/PRIVATE_KEY`, `GITHUB_API_URL`, `GITHUB_WEB_URL`, `FRONTEND_URL` | `src/config/env.schema.ts`, `.env.example` |

### Command results

| Command | Result |
| --- | --- |
| prettier check, lint, typecheck, build | pass |
| `npm test` | 347 passed |
| `npm run test:e2e` | 16 passed |
| `npm run test:int` | 195 passed (20 in `github.int-spec.ts`, against an in-process fake GitHub that verifies the app JWT with the real public key) |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-10.1 | **BLOCKED** — verified with a simulated GitHub only | A signed, real-format `issues.opened` payload for the connected installation runs the published workflow end to end (condition on labels, mapped message `Prod issue #42: Login page crashes`). A real event from github.com still needs your GitHub App (setup guide above) |
| AC-10.2 | PASS | Unit: wrong secret and tampered body rejected; integration: 401 |
| AC-10.3 | PASS | Same `X-GitHub-Delivery` twice → one run, second response `duplicate: true` |
| AC-10.4 | PASS | All responses in the suite scanned: no client secret, webhook secret, private key, `ghu_`/`ghs_` tokens. DB: no `IntegrationCredential` rows, OAuth state stored only as a hash. Logs: suite re-run at info level (126 JSON lines) contains none of them; all `authorization` and `x-hub-signature-256` header values are `[REDACTED]` |
| AC-10.5 | PASS (adapted) | No GitHub *action* exists, so no run uses GitHub credentials. Revocation is handled where credentials are used: a 401 from GitHub marks the connection NEEDS_ATTENTION (409 to the caller) and reconnecting restores it; `installation.deleted` marks it DISCONNECTED and events stop triggering |
| AC-10.6 | PASS | Unit: 429, 403 with `x-ratelimit-remaining: 0` or `retry-after` → retryable PROVIDER_RATE_LIMIT with delay from `retry-after` or `x-ratelimit-reset`; integration: rate limit → 503 without touching the connection |

**Mutation checks:** disabling the publish-time connection check, or the webhook account binding, makes the tenant-isolation tests fail (5 failures); restored afterwards.

### Decisions and limitations

- **Security fix beyond the spec:** without the publish-time connection check, a user could paste another workspace's `connectionId` and receive that workspace's GitHub events. Now refused with `CONNECTION_INVALID`, and the webhook pipeline additionally requires the event's installation to match the trigger's connection.
- The same installation may be connected to several workspaces, but each binding requires a user who can access that installation.
- **Not verified against github.com:** whether GitHub forwards the `state` parameter through the install-with-OAuth redirect exactly as assumed. This is checked as part of AC-10.1.
- Optional `github.issue.addComment` action not implemented (not needed for the flagship workflow).
- Disconnect only unbinds the connection in FlowForge; uninstalling the app is done on GitHub.
