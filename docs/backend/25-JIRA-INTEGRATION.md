# 25 — Jira Cloud Integration

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

## Objective

A production-quality Jira Cloud integration on the existing integration framework: OAuth 2.0 (3LO) connections per workspace, three triggers (issue created, updated, transitioned) delivered by Jira webhooks, and seven real actions (create, get, update, comment, transition, assign, search) — with token refresh, webhook lifecycle/renewal, normalised errors and tenant isolation.

## Why This Part Exists

Jira is where many engineering and operations teams track work; GitHub → Jira, email → Jira and periodic Jira reports are core scenarios. It also exercises two platform capabilities the existing providers do not: **provider webhooks registered per connection that expire** (renewal jobs), and **multiple provider sites per grant**.

## Existing architecture this part builds on (inspected 2026-10-03)

| Component | Today | Use / change |
| --- | --- | --- |
| `IntegrationProvider` (`connectUrl`, `completeConnection`, `revoke`, PKCE option) + shared `IntegrationsService` (state, membership, persistence, redirects) | GitHub, Slack, Microsoft | add `jira.provider.ts` |
| Token refresh with locking + rotation (`MicrosoftTokenManager`, Part 14) | Microsoft only | generalise into a shared `OAuthTokenManager` used by Microsoft and Jira (and Gmail in Part 26) — refactor with Microsoft tests kept green |
| `WebhookProvider` adapters + intake pipeline (verify, dedup by `@@unique(provider, deliveryId)`, normalize → `NormalizedEvent`, route by `eventType` + `resourceKey` + `accountId`) | GitHub, TEST | add `jira` adapter |
| `WorkflowTrigger` (one per workflow, `connectionId`) | GitHub routing | Jira triggers route by connection |
| Maintenance queue job schedulers | sweeper, retention | add `renew-jira-webhooks` |
| Provider concurrency + `Retry-After` backoff | yes | add `jira` prefix |
| `ConnectionStatus` + `statusReason` (Part 24) | | `NEEDS_ATTENTION` reasons for revoked tokens / failed renewal |

## Scope

Jira Cloud only (not Data Center/Server). OAuth 2.0 (3LO) connect, site selection, token refresh, disconnect/revoke; triggers via dynamically registered webhooks; actions; renewal job; error mapping; tests with a mocked Jira; documented real-site E2E.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-25.1 | Connect (ADMIN): authorization-code flow with `audience=api.atlassian.com`, `prompt=consent`, state (and PKCE if supported) through the shared service. Scopes (minimum, to verify): `read:jira-work`, `write:jira-work`, `read:jira-user`, `manage:jira-webhook`, `offline_access`. After token exchange, list accessible sites; **one FlowForge connection per Jira site** (`externalAccountId = cloudId`, `accountLabel = site name/URL`) — if the grant includes several sites, the user picks one (or one connection per site is created — decision). |
| FR-25.2 | Tokens encrypted (Part 17); access tokens refreshed with the shared locked refresh (rotating refresh tokens persisted atomically); `invalid_grant` → `NEEDS_ATTENTION (TOKEN_REVOKED)`; reconnect replaces credentials on the same connection (existing upsert by `workspaceId, provider, externalAccountId`). Disconnect deletes credentials, deregisters webhooks (best effort) and revokes if supported. |
| FR-25.3 | Triggers: `jira.issue.created`, `jira.issue.updated`, `jira.issue.transitioned` (an update whose changelog contains a `status` change; config can filter `toStatus` / `fromStatus`). Config: `connectionId`, `projectKeys` (1–20), optional `issueTypes`, optional JQL filter (validated length, no secrets). |
| FR-25.4 | Publishing a workflow with a Jira trigger registers (or reuses) a dynamic webhook on that site with a JQL filter covering the trigger's projects and the needed events; stored in `JiraWebhookRegistration` with the provider webhook id, events, JQL, `expiresAt`. Archive/delete/new version without the trigger deregisters when no other workflow on that connection needs it (reference-counted per connection + JQL). |
| FR-25.5 | Webhook intake `POST /webhooks/jira` (Part 09 pipeline): verify authenticity (mechanism to verify against Atlassian docs — signed JWT if provided for OAuth-app webhooks, otherwise a per-registration secret path token), dedup (delivery id from Jira headers/payload, else a hash of webhook id + issue id + timestamp + event), route by `cloudId` + registration → connection → matching triggers (project/type/status filters), acknowledge quickly, create runs asynchronously. Normalised trigger output: `{ event, issue: { id, key, summary, status, type, priority, project, assignee, reporter, labels, url, created, updated }, changes: [{ field, from, to }], actor, site }` — description text trimmed and size-limited. |
| FR-25.6 | Actions (all with `connectionId`, templated fields): `jira.createIssue` (project, issue type, summary, description (plain text → ADF), priority, labels, assignee account id, custom fields map limited), `jira.getIssue` (key/id, fields list), `jira.updateIssue` (fields), `jira.addComment` (text → ADF), `jira.transitionIssue` (target status name or transition id; resolves the transition), `jira.assignIssue` (account id, or "unassigned"), `jira.searchIssues` (JQL, max results ≤ 100, fields) — outputs normalised like the trigger issue shape. |
| FR-25.7 | Side-effect classes: create/update/comment/transition/assign are non-idempotent (Part 15: uncertain outcome not auto-retried; create may use a client-side idempotency marker if Jira supports one — to verify); get/search are read-only and retryable. |
| FR-25.8 | Renewal: a maintenance job (`renew-jira-webhooks`, e.g. every 6 h) refreshes registrations expiring within a safety window (e.g. 7 days before a 30-day expiry — exact provider lifetime to verify) and re-registers missing ones; 3 consecutive failures → connection `NEEDS_ATTENTION (WATCH_RENEWAL_FAILED)`, logged and visible in the UI; success clears it. |
| FR-25.9 | Resource pickers for the editor: `GET /workspaces/:ws/integrations/:connectionId/jira/projects`, `…/jira/issue-types?project=`, `…/jira/statuses?project=`, `…/jira/users?query=` (assignable users, minimal fields). |

## Technical Requirements

- Jira REST v3 through `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...` (server-configured base; not user-controlled — outside the HTTP-action egress guard).
- A `JiraClient` with timeouts, `Retry-After` parsing, ADF conversion for plain text, and error normalisation; handlers in the worker only.
- Webhook registration calls happen in the worker/maintenance context or in the publish transaction's post-commit hook (decision: post-commit job, so publish is not blocked by Jira latency; trigger becomes active when registration succeeds and the workflow shows "listening" state).

## API Requirements

Existing patterns only: `GET /integrations/providers` (adds `JIRA`), `POST /workspaces/:ws/integrations/JIRA/connect`, `GET /integrations/jira/callback`, `DELETE …/integrations/:connectionId`, resource pickers (FR-25.9), `POST /webhooks/jira`, `GET /node-types` (new types). Optional: `GET /workspaces/:ws/workflows/:id/trigger-status` (listening / registering / failed) — shared with Gmail.

## Database / persistence changes

- `IntegrationProviderKey` + `JIRA`.
- `JiraWebhookRegistration`: `id`, `workspaceId`, `connectionId`, `providerWebhookId`, `events String[]`, `jqlFilter`, `expiresAt`, `lastRenewedAt`, `consecutiveFailures`, `status`, `secretTokenHash?`; unique `(connectionId, providerWebhookId)`; index `(expiresAt)`.
- Possibly a generic `ProviderSubscription` table shared with Gmail watches (decision: one table with `provider` + JSON details vs two specific tables — recommended **one generic table** to avoid parallel mini-frameworks).
- `WorkflowTrigger` rows for Jira triggers: `eventType` = normalised event, `resourceKey` = `cloudId:projectKey` (or JSON filter), `connectionId` set.

## Security Requirements

Tokens encrypted and never returned; minimal scopes with rationale documented; webhook authenticity verified (or secret path token, constant-time compare); payloads normalised and size-limited (no raw bodies stored); JQL is passed only to Jira, never interpreted by FlowForge; descriptions/comments treated as untrusted text (AI prompt-injection guidance of Part 12 applies if fed to AI).

## Multi-Tenant Requirements

Connections belong to one workspace; credential lookups by `{ id, workspaceId, provider: JIRA }`; the same Jira site may be connected by two workspaces (two connections, two registrations — events route only to triggers whose connection received the webhook); a foreign `connectionId` fails at publish and execution; tenant-isolation suite covers pickers and connection routes.

## Error Handling

401 → refresh once then `PROVIDER_AUTH` + `NEEDS_ATTENTION (TOKEN_EXPIRED/REVOKED)`; 403 → `AUTHORIZATION` (permission/scope; `PERMISSION_CHANGED` if scopes missing); 404 → `PERMANENT_PROVIDER_ERROR` (issue/project not found or no access); 400 → `VALIDATION` with Jira's field errors (safe subset); 409 → `PERMANENT_PROVIDER_ERROR`; 429 → `PROVIDER_RATE_LIMIT` honour `Retry-After`; 5xx/network → transient (reads retried; writes uncertain if possibly applied); timeouts per Part 18.

## Observability

Log ids only (connection, cloudId, webhook id, issue key may be logged — decision: issue key yes, summary no), event type, routing outcome, renewal results, rate-limit hits; counters for renewals ok/failed, webhook dedup, 429s.

## Testing Requirements

Mock Jira (HTTP-level, like the Slack/Microsoft simulated providers): OAuth state + callback + site selection, token storage and refresh with rotation, refresh race, revoked token → NEEDS_ATTENTION, disconnect (deregister + revoke), every action incl. ADF and transition resolution, search paging limits, trigger ingestion for each event, duplicate webhook → one run, invalid/unknown registration or connection → ignored, foreign connection rejected, 429 with Retry-After, 5xx, timeout, renewal success/failure/threshold, publish/archive registration lifecycle.

**Real Jira Cloud E2E (documented, recorded):** free Jira Cloud site + Atlassian developer console app (OAuth 2.0, callback `https://<public-url>/api/v1/integrations/jira/callback`, scopes above), public URL (ngrok as in Parts 10/13); connect, publish "Jira issue created → Slack", create an issue in Jira, observe run; run "GitHub issue → Jira create" and verify the issue.

## E2E Scenarios

- **S25.1** Jira issue transitioned to "Done" → Slack notify.
- **Scenario 3 — Engineering:** GitHub issue → condition/AI → `jira.createIssue` → Slack.
- **Scenario 5 — Periodic reporting** (with Parts 23/26): schedule → `jira.searchIssues` → AI summarise → Gmail.
- **Scenario 2 — Email triage** (with Part 26): Gmail → AI → condition → `jira.createIssue` → Slack.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-25.1 | Connect, refresh, revoke/reconnect and disconnect work with encrypted tokens and correct NEEDS_ATTENTION reasons | Mock-provider integration tests |
| AC-25.2 | All seven actions produce correct Jira requests and normalised outputs; side-effect classes respected | Integration tests |
| AC-25.3 | The three triggers ingest, dedupe, filter and route to the right workspace/connection only | Integration tests |
| AC-25.4 | Webhook registrations follow publish/archive and are renewed before expiry; repeated failure surfaces NEEDS_ATTENTION | Integration tests with fake clock |
| AC-25.5 | 401/403/404/429/5xx/timeouts are normalised and retried per policy | Integration tests |
| AC-25.6 | A real Jira Cloud site completes Scenario 3 | Recorded manual E2E |

## Definition of Done

Roadmap DoD plus all AC; Microsoft tests still green after the token-manager refactor; scope rationale and setup guide in this file.

## Dependencies

Parts 09, 10 (pattern), 14 (token manager to generalise), 15, 17, 18, and Part 24 (`statusReason`, shared subscription/credential conventions). Part 23 for scenario 5.

## Out of Scope

Jira Data Center/Server, Jira Service Management/Confluence, attachments, issue deletion trigger, worklogs, sprint/board operations, Forge/Connect apps.

## Risks / Design Questions

- Webhook authenticity mechanism for OAuth-app dynamic webhooks and their exact expiry — **verify in Atlassian docs** before implementation; fallback is a per-registration secret path token.
- Multi-site grants: one connection per site vs site chosen per node.
- Webhook registration limits per app/site; JQL filter constraints for dynamic webhooks.
- Atlassian app distribution/approval for public use (for a portfolio deployment the app can stay private/development).

## Implementation Notes

Mirror the Slack/Microsoft structure (`src/modules/integrations/jira/{jira.provider,jira-client,jira.node-types,jira-webhook.provider}.ts`); register node types in the catalog like the others; keep the trigger/action names consistent with existing conventions (`github.issue.created`, `slack.sendMessage`). Mapping from the roadmap request names: `jira.issue.create → jira.createIssue`, `jira.issue.get → jira.getIssue`, `jira.issue.update → jira.updateIssue`, `jira.issue.comment → jira.addComment`, `jira.issue.transition → jira.transitionIssue`, `jira.issue.assign → jira.assignIssue`, `jira.issue.search → jira.searchIssues`.
