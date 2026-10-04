# 25 — Jira Cloud Integration

**Status:** COMPLETE: implemented, green against a simulated Atlassian, and verified end to end on a real Jira Cloud site (2026-10-04) (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

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

## Verified against Atlassian documentation (2026-10-04)

Checked before implementation, as the Risks section asks:

- **3LO.** The authorize URL `https://auth.atlassian.com/authorize` takes `audience=api.atlassian.com`, `client_id`, `scope`, `redirect_uri`, `state`, `response_type=code` and `prompt=consent`. The token endpoint is `POST https://auth.atlassian.com/oauth/token` (JSON body). Refresh tokens rotate: each new one invalidates the previous one, and one expires after 90 days of inactivity. An expired or invalid refresh token returns 403. Sites come from `GET https://api.atlassian.com/oauth/token/accessible-resources`, and REST calls go to `https://api.atlassian.com/ex/jira/{cloudId}/...`. PKCE is not documented for 3LO, and there is no token revocation endpoint (users revoke under "Connected apps"). Source: developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps.
- **Dynamic webhooks for OAuth 2.0 apps.**
  - Register with `POST /rest/api/3/webhook` (`url` must use the app's base URL; `webhooks: [{ events, jqlFilter }]`). Webhooks expire 30 days after creation or refresh; `PUT /rest/api/3/webhook/refresh` extends them by 30 days.
  - The limit is 5 webhooks per app per user per site.
  - JQL supports only `issueKey`, `project`, `issuetype`, `status`, `priority`, `assignee`, `reporter`, `issue.property` and `cf[id]`, with the operators `=`, `!=`, `IN` and `NOT IN`.
  - Deliveries carry `X-Atlassian-Webhook-Identifier` and `X-Atlassian-Webhook-Retry`. They are "secured by bearer authentication … signed with the app's client secret".
  - Source: developer.atlassian.com/cloud/jira/platform/webhooks.
- **Not stated by the docs:** the JWT algorithm. HS256 was assumed, since it is the HMAC-SHA256 shared-secret scheme Atlassian uses elsewhere. **Confirmed by the real-site E2E** (2026-10-04): real Atlassian deliveries verified with HS256 and the app's client secret.

## Implementation Evidence (2026-10-04)

**Delivered**
- **Connect** (`JiraProvider`, `JiraClient`): authorization code flow with the documented parameters and single-use `state`; scopes are checked on exchange, and a missing scope gives `not_authorized`.
  - **One connection per Atlassian grant** (`externalAccountId` = Atlassian account id from `/me`). The grant's Jira sites (Confluence-only resources left out) are stored in the connection metadata, and every Jira node chooses a `siteId`. This is the spec's "site chosen per node" option. One connection per site would hold several copies of one rotating refresh token, and refreshing any copy invalidates the rest.
  - Reconnect replaces the tokens on the same connection and clears `statusReason`.
  - Disconnect deletes the dynamic webhooks at Jira (best effort, new `beforeDisconnect` provider hook), then the tokens and registrations.
- **Shared `OAuthTokenManager`** (`src/modules/integrations/oauth/`): one implementation of locked refresh, rotation saved in the same transaction, single refresh for concurrent callers, and 401 → one forced refresh + retry. `MicrosoftTokenManager` is now a subclass with its behaviour unchanged (Microsoft unit and integration tests green). `JiraTokenManager` is a subclass that also checks a site belongs to the connection.
- **`ConnectionStatusReason`** (deferred by Part 24, added here) on `IntegrationConnection.statusReason`:
  - revoked grant → `TOKEN_REVOKED` (Jira, Microsoft, Slack);
  - Microsoft 403 → `PERMISSION_CHANGED`;
  - a fresh token rejected again → `AUTHENTICATION_FAILED`;
  - 3 failed webhook renewals → `WATCH_RENEWAL_FAILED`, which a later success clears. A renewal failure leaves the tokens usable, so actions keep working and renewal can retry.
- **Triggers** `jira.issue.created`, `jira.issue.updated` and `jira.issue.transitioned` (filter `projectKeys` 1–20, optional `issueTypes`; transitioned also `fromStatus` / `toStatus`). They are routed by `WorkflowTrigger` (resourceKey = site, `connectionId`, new `filter` column).
- **Webhook intake** `POST /webhooks/jira` (`JiraWebhookProvider`) on the Part 09 pipeline:
  - requires both Atlassian's bearer JWT (HS256, client secret, exp/nbf with 60 s leeway, `alg` must be HS256) and our signed URL parameters (connection + site, HMAC with the client secret);
  - dedup = Atlassian identifier + fingerprint of event, issue, changelog and timestamp;
  - one delivery can satisfy several event types (an update with a status change is both "updated" and "transitioned");
  - routed only to the connection whose webhook received it, so another workspace connected to the same Atlassian account never matches;
  - normalised output `{ event, issue { id, key, summary, description (text, ≤ 4 000), status, statusCategory, type, priority, project, assignee, reporter, labels, url, created, updated }, changes [{ field, from, to }], transition?, actor, site }`.
  - The pipeline gained, for every provider: `query` on inbound requests, `eventTypes`, `connectionId` binding and `matches(filter)`.
- **Webhook lifecycle** (`JiraSubscriptionsService`, worker; generic `ProviderSubscription` table, which Gmail will reuse):
  - one dynamic webhook per (connection, site) with JQL `project IN (…)`, the union of the published triggers' projects (keeps within Atlassian's 5-per-site limit; issue type and status are filtered by FlowForge);
  - registered, re-registered on change (old deleted first) and deleted when unused;
  - renewed when expiring within `JIRA_WEBHOOK_RENEW_WITHIN_DAYS` (7);
  - a periodic maintenance job (`SUBSCRIPTION_RENEW_INTERVAL_MS`, 1 h) plus an on-demand per-workspace job requested after publish / archive / unarchive / delete commit, so publishing never waits for Jira;
  - sync and renewal of one connection are serialised with a Postgres advisory lock (see "Found while testing").
- **Actions:**
  - `jira.createIssue`: project, issue type (name or id), summary, description (text → ADF), priority, labels, assignee account id, up to 20 `customfield_*` values.
  - `jira.getIssue`, `jira.updateIssue`, `jira.addComment` (text → ADF).
  - `jira.transitionIssue`: target status name resolved through the issue's transitions, or a transition id.
  - `jira.assignIssue`: account id or `unassigned`.
  - `jira.searchIssues`: `POST /search/jql`, ≤ 100 results.

  Outputs use the normalised issue shape. Rendered issue keys are validated before they reach a URL. Side effects: writes are `non-idempotent` (Jira has no idempotency key), reads are `idempotent`; AC-15.9 table and Part 15 doc updated. Provider slot group: `jira`.
- **Error mapping** (`mapJiraError`):
  - 401 → refresh + retry;
  - 403 → `AUTHORIZATION`;
  - 404 / 409 → `PERMANENT_PROVIDER_ERROR`;
  - 400 → `VALIDATION` with Jira's field messages (safe subset);
  - 429 / 503 → retry with `Retry-After`;
  - other 5xx → retry for reads, `UNCERTAIN_OUTCOME` for writes;
  - network and timeouts through the shared Part 15 classifier.
- **Pickers**: `GET /workspaces/:ws/integrations/:connectionId/jira/sites` (read live, refreshes the stored sites), `/jira/projects?siteId&query`, `/jira/issue-types?siteId&project`, `/jira/statuses?siteId&project`, `/jira/users?siteId&project&query`. Minimal fields only: no e-mail addresses, and inactive users left out.
- **Settings:** `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_AUTH_URL`, `JIRA_API_URL`, `JIRA_WEBHOOK_RENEW_WITHIN_DAYS`, `SUBSCRIPTION_RENEW_INTERVAL_MS`. Migration `20261005090000_jira`.

**Decisions / deviations from this spec**
- **Site chosen per node** (above), not one connection per site.
- **No per-trigger JQL filter:** one webhook per site cannot carry each trigger's own JQL (Atlassian's 5-webhook limit); projects, issue types and statuses cover the filtering.
- **The optional `GET …/trigger-status` endpoint** is not built. Registration state is in `ProviderSubscription` and visible on the connection through `statusReason`.
- **`jira.createIssue`** reads the created issue back for the normalised output; if that read fails, the step still succeeds with `{ id, key, url }`.
- **Issue keys** may be logged; summaries and descriptions are not.

**Found while testing**
- **Concurrent syncs** (the on-demand job and the periodic one, or two quick publishes) could both register a webhook for the same change. The row kept only the second, orphaning the first at Jira; disconnect then could not remove it. Fixed with a per-connection advisory lock (`pg_advisory_xact_lock`) around sync and renewal; pinned by a test with three concurrent syncs.
- **Renewal could never heal:** the token manager refused connections in `NEEDS_ATTENTION`, so after 3 failed renewals the connection stayed flagged forever. A `WATCH_RENEWAL_FAILED` connection is now usable (its tokens are fine), and the next successful renewal clears it.

**Verification**
- Unit: `src/modules/integrations/jira/jira.spec.ts`, 13 tests covering:
  - ADF round trip, issue normalisation, the Jira and token error tables;
  - signed URL parameters (tampered site / connection / secret);
  - bearer JWT (valid, wrong secret, missing, expired, `alg: none`, malformed);
  - adapter verify / normalize / filters / dedup;
  - node config validation and routing; JQL.
  - Microsoft unit tests unchanged (31) after the token manager refactor. Full unit suite: 52 suites / 734 tests.
- Integration: `test/integration/jira.int-spec.ts`, 23/23 against `FakeJira` (simulated 3LO with rotating refresh tokens, REST v3, dynamic webhooks):
  - connect with the documented parameters, sites stored and tokens encrypted; missing scopes refused; one refresh for concurrent callers, with rotation;
  - all seven actions chained (ADF bodies, transition resolution, normalised outputs);
  - a rendered non-key refused before any call; a foreign site refused;
  - create 5xx → `UNCERTAIN_OUTCOME` with a single call; reads retried on 5xx and 429; 403 / 404 / 400 mapped; 401 → refresh + retry;
  - publish registers one webhook with the projects JQL; a delivery gives one SUCCEEDED run with the normalised issue; Atlassian retry deduplicated; other project ignored; bad token or tampered URL → 401;
  - transitioned filter on to-status; a second workspace on the same Atlassian account gets nothing;
  - new projects re-register, archive removes, unarchive restores; concurrent syncs leave exactly one webhook;
  - renewal before expiry; 3 failures → `WATCH_RENEWAL_FAILED`, then healed;
  - pickers with minimal fields and foreign site → 422; another workspace gets 404 / `CONNECTION_INVALID`;
  - revoked grant → `TOKEN_REVOKED`, and reconnect heals it on the same connection;
  - disconnect deletes the webhooks and tokens; no secret in logs.

- Full integration suite: 25 suites, 392 tests. The first run failed 2 tests outside Jira. One asserted the exact connection response, which now includes `statusReason`. The other was an ordering flake in the Part 24 poll test: runs inserted together share `createdAt`, now sorted by item id. Both were fixed and re-run green, together with the Microsoft suite (token manager refactor) and the route inventory: 55/55.

## Setup guide (real Jira Cloud)

1. Create a free Jira Cloud site (atlassian.com/software/jira/free).
2. At developer.atlassian.com/console/myapps, create an **OAuth 2.0 integration**:
   - Permissions → Jira API: add `read:jira-work`, `write:jira-work`, `read:jira-user` and `manage:jira-webhook`. User identity API: `read:me`.
   - Authorization → callback URL `https://<public-url>/api/v1/integrations/jira/callback`.
3. Set `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `OAUTH_REDIRECT_BASE_URL=https://<public-url>/api/v1/integrations` and `PUBLIC_API_URL=https://<public-url>` (for example an ngrok URL, as in Parts 10/13). Webhooks go to `https://<public-url>/api/v1/webhooks/jira`, the same base URL as the app.
4. Connect Jira from the integrations page, then publish "Jira issue created → Slack" and create an issue in Jira (S25.1 / AC-25.6).

| AC | Status |
| --- | --- |
| AC-25.1 | Met (mock-provider integration) |
| AC-25.2 | Met (integration) |
| AC-25.3 | Met (integration) |
| AC-25.4 | Met (integration; the clock is moved by setting `expiresAt`) |
| AC-25.5 | Met (integration) |
| AC-25.6 | **Met (live)** for every Jira leg on a real Jira Cloud site; see "Real Jira Cloud E2E" below. The GitHub and Slack legs of Scenario 3 were not chained in this run (each was verified live in Parts 10 and 13) |

## Real Jira Cloud E2E (2026-10-04)

**Setup.** The product owner's free Jira Cloud site (`jacksonkhuto591.atlassian.net`, project `SCRUM`) and their Atlassian OAuth 2.0 app. The local API and worker ran on the dev stack, reached by Jira through an ngrok tunnel (`PUBLIC_API_URL`). A dedicated test user / workspace on the dev backend was used, and the OAuth flow was driven through the API. The product owner did the Atlassian login and consent in their browser (the frontend has no Jira card yet).

| Step | Result |
| --- | --- |
| Connect: `POST …/integrations/JIRA/connect` → Atlassian consent → `GET /integrations/jira/callback` | `CONNECTED`; scopes `read:jira-work write:jira-work read:jira-user manage:jira-webhook read:me offline_access`; site `jacksonkhuto591` stored in the connection metadata |
| Pickers: projects, issue types, statuses, assignable users | `SCRUM` "Flow Forge"; Epic / Subtask / Task / Story; To Do / In Progress / In Review / Done; one assignable user (no e-mail returned) |
| Actions, one manual run: create → comment → transition "In Progress" → assign → update summary → get → search (JQL) | Run SUCCEEDED, all 8 steps. **SCRUM-5** created with an ADF description, comment 10000, moved to In Progress, assigned, renamed, read back, found by `project = SCRUM AND labels = flowforge-e2e` |
| Publish `jira.issue.created` and `jira.issue.transitioned` (toStatus Done) on SCRUM | Dynamic webhook registered at Jira by the worker: webhook id 1, JQL `project IN ("SCRUM")`, expiry 30 days out, subscription ACTIVE |
| A workflow created **SCRUM-6** and moved it to Done; Jira sent the webhooks through the public URL | Two real deliveries (created, updated) passed both checks (signed URL + Atlassian bearer JWT, **HS256 confirmed**) and were stored `PROCESSED`. "Issue created" run SUCCEEDED (`event jira.issue.created`, issue SCRUM-6, status To Do, URL to the site); "transitioned" run SUCCEEDED (`transition: To Do → Done`) |

Not run live (covered by the mock-provider suite): refresh-token rotation over time, revocation, renewal near expiry, and disconnect. These depend on time passing or on destructive steps on the real account.

