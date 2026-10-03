# 26 — Gmail Integration

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

## Objective

Let Gmail mailboxes take part in workflows: Google OAuth 2.0 connections per workspace (several mailboxes per workspace), two triggers (new email, new email with a label) delivered by **Gmail push notifications via Google Cloud Pub/Sub**, and seven actions (send, reply in thread, get, add/remove label, mark read/unread) — with watch renewal, history-based change resolution, deduplication, minimal scopes and careful handling of sensitive email data.

## Why This Part Exists

Email is the entry point for support, sales and operations work; "new support email → classify → Jira → Slack" and "send the daily report" are flagship scenarios. Gmail also exercises the push-notification model (Pub/Sub, history ids, expiring watches), which must be built on the same subscription/renewal infrastructure as Jira rather than a separate mini-framework.

## Existing architecture this part builds on (inspected 2026-10-03)

| Component | Today | Use / change |
| --- | --- | --- |
| `IntegrationProvider` + shared OAuth state/PKCE/persistence | GitHub, Slack, Microsoft (PKCE) | add `google` provider (Gmail) |
| Shared locked token refresh (generalised in Part 25 from `MicrosoftTokenManager`) | | reuse for Google refresh tokens |
| Provider subscription table + renewal maintenance job (Part 25, `ProviderSubscription` recommended) | | Gmail watches are subscriptions with `expiresAt` + `historyId` |
| Webhook intake pipeline (verify, dedup, normalize, route, async run) | GitHub, TEST, Jira, generic | Pub/Sub push endpoint is a `WebhookProvider` with an extra "resolve changes" step in the worker |
| Engine/handlers, side-effect classes, `Retry-After` backoff, provider concurrency | | add `gmail` prefix |
| Retention (Part 21) | step payload trimming, run deletion | email content in run/step data follows it |
| Redactor (Part 17) | tokens, secrets | extend for email bodies in logs (never logged) |

## Scope

Google OAuth for Gmail scopes; one connection per mailbox; Pub/Sub push intake; history resolution; watch create/renew/stop; triggers; actions; editor pickers (labels); tests with a mocked Gmail/Pub/Sub; documented real-mailbox E2E. Google Workspace domain-wide delegation, other Google products and polling-first designs are out of scope.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-26.1 | Connect (ADMIN): Google authorization-code flow with PKCE, `access_type=offline`, `prompt=consent` (to obtain a refresh token), state via the shared service. **Scopes (minimum for the implemented features, rationale documented):** `gmail.modify` (read messages/history, labels, read/unread, required for triggers and get/label actions) and `gmail.send` (send/reply); `openid email` to label the connection with the mailbox address. Note: `gmail.modify` is a Google **restricted scope** (verification + security assessment for public apps) — see Risks. `externalAccountId` = Google user id (`sub`), `accountLabel` = email address. |
| FR-26.2 | Tokens encrypted; refresh via the shared locked refresh; `invalid_grant` → `NEEDS_ATTENTION (TOKEN_REVOKED)`; missing granted scope → `NEEDS_ATTENTION (PERMISSION_CHANGED)`; reconnect replaces credentials; disconnect stops the watch, deletes credentials and revokes the token (best effort). |
| FR-26.3 | Triggers: `gmail.email.received` (any new message in the inbox — `INBOX` label added — excluding messages sent by the mailbox itself, configurable) and `gmail.email.labelReceived` (new message gets label X, chosen by label id from a picker). Config: `connectionId`, `labelId?`, and a reserved `filter` object (`from`, `to`, `subjectContains`, `query`) — only fields implemented are accepted, so later filters extend the contract without breaking it. |
| FR-26.4 | **Watch lifecycle:** while ≥ 1 published workflow uses a Gmail trigger on a connection, the connection has an active `users.watch` on the FlowForge Pub/Sub topic (label filter `INBOX` or the union of labels in use); stored as a provider subscription with `historyId` (start point) and `expiresAt` (Gmail watches expire after about 7 days — verify; renew daily as Google recommends). The last workflow unpublished/archived/deleted → `users.stop`. |
| FR-26.5 | **Pub/Sub push intake** `POST /webhooks/gmail`: verify the push request (Pub/Sub OIDC JWT: issuer Google, audience = our endpoint, service-account email = configured), decode `message.data` → `{ emailAddress, historyId }`, dedup by Pub/Sub `messageId`, find the connection by mailbox, acknowledge `204` quickly, and enqueue a **history-resolution job** (maintenance/integration queue) — no Gmail API calls in the request. |
| FR-26.6 | **History resolution (worker):** under a per-connection lock (DB row lock or advisory lock), call `users.history.list(startHistoryId = stored historyId, historyTypes = messageAdded/labelAdded)`, collect new message ids (and label additions for the label trigger), fetch metadata/payload per message (format `full` or `metadata` + selected parts, size-capped), match triggers, create **one run per (trigger, message)** with idempotency key `gmail:<connectionId>:<messageId>:<triggerId>` (unique index guarantees no duplicates across duplicate notifications or concurrent resolvers), then advance the stored `historyId` to the latest seen. |
| FR-26.7 | **Missed history:** if `history.list` returns 404 (start id too old — e.g. after a long outage), record a gap event (log + connection notice), reset to the current `historyId` from `users.getProfile`, and do **not** backfill by default (documented; optional bounded catch-up via `messages.list` newer than the last processed time is a decision). |
| FR-26.8 | Trigger output (minimised, see Data Security): `{ messageId, threadId, labelIds, from, to, cc, subject, snippet, date, textBody (plain text, size-capped e.g. 32 KB), hasAttachments, attachmentNames, mailbox }` — HTML converted to text; raw MIME and attachments are **not** persisted. |
| FR-26.9 | Actions: `gmail.sendEmail` (to/cc/bcc, subject, text body, optional HTML body, reply-to; MIME built server-side with header injection prevention), `gmail.replyToEmail` (messageId → keeps `threadId`, `In-Reply-To`, `References`, `Re:` subject; reply or reply-all), `gmail.getEmail` (messageId → normalised message as FR-26.8), `gmail.addLabel` / `gmail.removeLabel` (label id), `gmail.markAsRead` / `gmail.markAsUnread`. Send/reply are non-idempotent (uncertain outcome not auto-retried); label/read changes are idempotent and retryable; get is read-only. |
| FR-26.10 | **Renewal job** (`renew-gmail-watches`, maintenance queue, e.g. every 6 h): renew watches expiring within 2 days (renewing is idempotent and returns a new expiration); 3 consecutive failures → `NEEDS_ATTENTION (WATCH_RENEWAL_FAILED)`; expired watch detected → re-watch and run the missed-history procedure. Never depends on the UI. |
| FR-26.11 | Editor pickers: `GET /workspaces/:ws/integrations/:connectionId/gmail/labels` (id, name, type). |

## Technical Requirements

- Gmail REST v1 via a `GmailClient` (server-configured base URL, timeouts, `Retry-After`, quota-error mapping); MIME building with a vetted library or minimal internal builder with strict header encoding (RFC 2047) and CRLF rejection.
- Google Cloud setup (operator): project, Pub/Sub topic, grant `gmail-api-push@system.gserviceaccount.com` publish rights, push subscription to `https://<public-url>/api/v1/webhooks/gmail` with OIDC auth (service account + audience). Config: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_AUDIENCE`, `GMAIL_PUSH_SERVICE_ACCOUNT`.
- History resolution and renewals run in the worker; per-connection serialisation to keep `historyId` monotonic.
- Provider concurrency limit for `gmail` (Gmail per-user quota) and burst smoothing for notification storms (many notifications coalesce into one resolution per connection).

## API Requirements

Existing patterns: `GET /integrations/providers` (+ `GMAIL`), `POST /workspaces/:ws/integrations/GMAIL/connect`, `GET /integrations/gmail/callback`, `DELETE …/integrations/:connectionId`, labels picker, `POST /webhooks/gmail` (public, OIDC-verified), `GET /node-types` (new types). Shared optional trigger-status endpoint (listening / renewing / needs attention) with Jira.

## Database / persistence changes

- `IntegrationProviderKey` + `GMAIL`.
- Provider subscription rows (shared table from Part 25): `provider = GMAIL`, `connectionId`, `historyId`, `expiresAt`, `labelFilter`, `consecutiveFailures`, `status`, `lastNotificationAt`.
- `WebhookDelivery` rows for Pub/Sub messages (`deliveryId` = Pub/Sub `messageId`, payload = `{ emailAddress, historyId }` only).
- No email bodies outside run/step data (which retention trims).

## Security Requirements

- Tokens encrypted, never returned; minimal scopes with written rationale; OIDC verification of push requests (signature, issuer, audience, email, expiry) — unauthenticated pushes rejected.
- **Email data security:** never log subjects, bodies, addresses beyond the mailbox's own (logs carry message ids, sizes, counts); trigger output and step data store only the minimised fields of FR-26.8, size-capped; attachments and raw MIME never stored; retention (Part 21) trims step payloads; redaction rules extended (secret canary suite gains an email-body canary); AI steps receiving email text follow Part 12's prompt-injection handling (email is untrusted input).
- Outgoing email: header injection prevented; optional per-workspace daily send cap to limit abuse; From is always the connected mailbox.

## Multi-Tenant Requirements

- Connection per mailbox per workspace; the same mailbox connected by two workspaces → two connections; a notification for a mailbox routes to **every** active connection for that address, and each resolves history with its own credentials and creates runs only for its own workspace's triggers (decision: dedupe the watch per mailbox while keeping per-connection history state — Gmail allows one watch per user per topic; document the shared-watch handling).
- Credential lookups `{ id, workspaceId, provider: GMAIL }`; foreign `connectionId` rejected at publish and execution; tenant-isolation suite covers pickers and connection routes.

## Error Handling

401 → refresh once, then `PROVIDER_AUTH` + `NEEDS_ATTENTION`; 403 `insufficientPermissions` → `PERMISSION_CHANGED`; 403/429 rate/quota (`rateLimitExceeded`, `userRateLimitExceeded`) → `PROVIDER_RATE_LIMIT` with backoff; 404 message/label not found → `PERMANENT_PROVIDER_ERROR`; history 404 → missed-history procedure; 5xx/network/timeout → transient for reads/labels, uncertain for send/reply when possibly delivered.

## Observability

Notifications received/deduped, resolutions (messages found, runs created, duration, historyId advance), gaps, watch renewals ok/failed, send counts, quota errors — all with ids/counts only.

## Testing Requirements

Mock Google OAuth/Gmail/Pub/Sub at HTTP level: OAuth callback + state + PKCE, refresh, revocation, scope loss; send (MIME correctness, header injection rejected), reply (thread headers), get (HTML→text, size caps, no attachments stored), labels add/remove, read/unread; push verification (valid/invalid OIDC), duplicate notifications → one resolution/run set, concurrent resolvers → no duplicate runs, history paging, label trigger, self-sent exclusion, missed history (404) handling, watch create/renew/stop with publish lifecycle, expired watch recovery, renewal failure threshold → NEEDS_ATTENTION, 429/5xx/timeout, secret and email-body redaction in logs, cross-workspace isolation including the shared-mailbox case.

**Real Gmail E2E (documented, recorded):** Google Cloud project with Gmail API, OAuth client (testing mode with test users — no verification needed for test users), Pub/Sub topic + push subscription to the public URL, connect a test mailbox, publish "Gmail new email → Slack", send an email to it, observe the run; run the send/reply actions.

## E2E Scenarios

- **S26.1** New email with label "support" → Slack notify.
- **Scenario 2 — Email triage:** Gmail new support email → AI classify/extract (current AI steps; per-workspace AI keys are a later enhancement) → condition priority == HIGH → `jira.createIssue` → Slack.
- **Scenario 1 — Daily operations:** schedule weekday 07:00 → HTTP fetch → condition → `gmail.sendEmail` report.
- **Scenario 5 — Periodic reporting:** schedule Friday 16:00 → Jira search → AI summarise → `gmail.sendEmail`.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-26.1 | Connect/refresh/revoke/reconnect/disconnect with encrypted tokens, minimal scopes and correct NEEDS_ATTENTION reasons | Mock-provider integration tests |
| AC-26.2 | Push intake verifies, deduplicates and resolves history into exactly one run per (trigger, message), including duplicates and concurrency | Integration tests |
| AC-26.3 | Watches follow publish/archive, renew before expiry, recover after expiry; failures surface NEEDS_ATTENTION | Integration tests with fake clock |
| AC-26.4 | All seven actions behave correctly (MIME, threading, labels, read state) with correct side-effect classes | Integration tests |
| AC-26.5 | Email content never appears in logs; stored data is minimised and retention-trimmed | Canary + log assertion tests |
| AC-26.6 | Scenarios 2 and 1 pass with a real mailbox | Recorded manual E2E |

## Definition of Done

Roadmap DoD plus all AC; scope rationale, data-handling statement and Google Cloud setup guide in this file.

## Dependencies

Parts 09, 15, 17, 18, 21 (retention), 23 (scheduler, for scenarios), 24 (`statusReason`), **25 (shared subscription table, renewal job pattern, generalised token manager)**.

## Out of Scope

Attachments (download/upload), drafts, Gmail search-based polling as primary trigger, Google Workspace admin/delegation, other Google APIs (Calendar, Drive), full-mailbox backfill.

## Risks / Design Questions

- **Restricted scopes:** `gmail.modify`/`gmail.readonly` require Google verification and an annual security assessment for production use by external users; testing mode allows up to 100 test users. Product decision: stay in testing mode for the portfolio deployment, or narrow features (e.g. send-only with `gmail.send`, which is sensitive but not restricted).
- One watch per mailbox per topic vs several workspaces connecting the same mailbox.
- Default missed-history policy (no backfill) vs bounded catch-up.
- How much body text to keep (32 KB default) given retention and privacy.

## Implementation Notes

Structure like the other providers (`src/modules/integrations/gmail/...`); the Pub/Sub adapter is a `WebhookProvider` whose `normalize` returns a "resolve mailbox" internal event handled by a worker job instead of matching triggers directly. Name mapping from the roadmap request: `gmail.email.received` (kept), `gmail.email.label.received → gmail.email.labelReceived`, `gmail.email.send → gmail.sendEmail`, `gmail.email.reply → gmail.replyToEmail`, `gmail.email.get → gmail.getEmail`, `gmail.label.add → gmail.addLabel`, `gmail.label.remove → gmail.removeLabel`, `gmail.email.markRead → gmail.markAsRead`, `gmail.email.markUnread → gmail.markAsUnread` (consistent with `slack.sendMessage`, `microsoft.todo.createTask`).
