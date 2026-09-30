# 10 — GitHub Integration

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

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
| GET | `/api/v1/integrations/github/callback` | Public (state-authenticated) → redirect to frontend |
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
