# 26 — Gmail Integration

**Status:** COMPLETE WITH EXCEPTIONS (2026-10-04): verified end to end against a real Gmail mailbox (OAuth, watch, Pub/Sub push, history resolution, all seven actions, Scenario 1). Exception: Scenario 2's AI step was not run live (no Anthropic key, as in Part 22) — see [Real Gmail E2E](#real-gmail-e2e-2026-10-04) and [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

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

## Verified against Google documentation (2026-10-05)

- **Push** (developers.google.com/gmail/api/guides/push):
  - `users.watch` takes `topicName`, `labelIds` and `labelFilterBehavior: INCLUDE`, and returns `historyId` and `expiration` (ms). "You must call the watch method at least once every 7 days … We recommend calling watch once per day."
  - The notification `message.data` is base64url JSON `{ emailAddress, historyId }`. `users.stop` ends notifications.
  - Publish rights on the topic go to `gmail-api-push@system.gserviceaccount.com`. At most one notification per second per watched user.
- **History** (users.history.list): `startHistoryId`, `historyTypes` (messageAdded, labelAdded, …), `maxResults` ≤ 500, `pageToken`. An outdated `startHistoryId` "typically returns an HTTP 404"; history ids stay valid for at least a week, sometimes only hours.
- **Pub/Sub push authentication** (docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions): `Authorization: Bearer <JWT>`, RS256, `iss` = `https://accounts.google.com`, `aud` = the configured audience, `email` = the configured service account with `email_verified: true`, tokens up to an hour old. Verified offline against Google's public keys (`GOOGLE_JWKS_URL`, default `https://www.googleapis.com/oauth2/v3/certs`).

## Scope rationale (FR-26.1)

| Scope | Why | Google class |
| --- | --- | --- |
| `gmail.modify` | Read history and messages (triggers, get), change labels and read state. The narrowest scope covering reading *and* label changes; it cannot delete mail permanently. | restricted |
| `gmail.send` | Send and reply. | sensitive |
| `openid`, `email` | Google user id (`sub`) and the mailbox address of the connection. | non-sensitive |

Full mail access (`https://mail.google.com/`) is not requested. Restricted scopes need Google verification and an annual security assessment for public use. For this deployment the OAuth app stays in **testing mode** (up to 100 test users, no verification), as the Risks section proposes. A send-only product would need only `gmail.send`.

## Data-handling statement (AC-26.5)

- **Push deliveries** store only `{ emailAddress, historyId }` (the Pub/Sub message id is the dedup key).
- **Trigger output and `gmail.getEmail`** keep only the minimised message: id, thread, labels, from/to/cc/reply-to, subject, snippet, date, plain text body (HTML converted to text) capped at `GMAIL_MAX_BODY_CHARS` (32 KB, `textTruncated` when cut), attachment **names**, and mailbox. Raw MIME and attachment contents are never fetched or stored. That data lives only in run / step data, which retention trims (Part 21).
- **Logs** carry ids and counts only (connection, message ids, run counts, history gaps), never addresses other than the connection's own, subjects or bodies. A body canary and a subject canary are asserted absent from all logs in the integration suite.
- **Email is untrusted input.** When fed to AI steps, Part 12's prompt-injection handling applies.
- **Outgoing mail:**
  - From is always the connected mailbox;
  - header values with CR/LF are refused and addresses validated, so a rendered header injection is never sent;
  - non-ASCII headers are RFC 2047 encoded;
  - sends are limited by `GMAIL_DAILY_SEND_CAP_PER_WORKSPACE` (default 500/day, Redis; fails closed).

## Implementation Evidence (2026-10-05)

**Delivered**
- **Connect** (`GmailProvider`, `GmailClient`): authorization code with PKCE (S256), `access_type=offline` and `prompt=consent`; granted scopes checked (Google allows unticking them); verified email required.
  - One connection per mailbox (`externalAccountId` = `sub`, label = address).
  - Shared locked refresh (`GmailTokenManager` on Part 25's `OAuthTokenManager`):
    - `invalid_grant` → `TOKEN_REVOKED`;
    - 403 missing permissions → `PERMISSION_CHANGED`;
    - Google keeps the refresh token on refresh, and the stored one is kept.
  - Disconnect stops the watch (unless another connection watches the same mailbox), revokes the refresh token at Google and deletes the tokens.
- **Push intake** `POST /webhooks/gmail` (`GmailPushProvider` + `GoogleOidcVerifier`):
  - offline OIDC verification (RS256, issuer, audience, service account, `email_verified`, expiry; keys cached for 1 h, unknown key id refetched at most once a minute); unauthenticated pushes → 401 with nothing stored;
  - dedup by Pub/Sub message id; payload `{ emailAddress, historyId }` only;
  - the delivery is **deferred**: no Gmail call in the request. After commit, one resolution job per connection watching that mailbox goes on the new `provider-events` queue, and jobs of one mailbox within 2 s coalesce.
  - The shared pipeline gained async `verify`, `deferred` events and an `afterRecord` hook.
- **History resolution** (`GmailSyncService.resolve`, worker), under a per-connection advisory lock:
  1. page `history.list` from the stored `historyId` (messageAdded + labelAdded, up to 20 pages);
  2. match triggers by label (INBOX for "new email", the chosen label for "gets a label");
  3. fetch only matching messages (up to 200 per resolution);
  4. apply the trigger filters (self-sent excluded unless `includeSentByMe`; `from` and `subjectContains`, the only filter fields accepted so far);
  5. insert runs with ON CONFLICT DO NOTHING on `gmail:<connectionId>:<messageId>:<workflowId>`;
  6. advance `historyId`, never backwards.

  On a history 404 (FR-26.7), the gap is recorded on the subscription (`gapAt`, `lastError`), the resolver restarts from `users.getProfile`'s current id, and there is **no backfill**.
- **Watch lifecycle** (`GmailSyncService.run`, run by Part 25's periodic and on-demand subscription jobs; `ProviderSubscription` row per connection):
  - a watch on `GMAIL_PUBSUB_TOPIC` with the union of labels in use; re-watch on a label change;
  - renewal within `GMAIL_WATCH_RENEW_WITHIN_HOURS` (48 h; the periodic job runs hourly, so in practice daily, as Google recommends), keeping the stored history position;
  - an expired watch is re-watched and a resolution is queued to catch up;
  - 3 failures → `WATCH_RENEWAL_FAILED`, which the next success clears;
  - the last trigger gone → `users.stop`, unless another connection shares the mailbox, then the row is removed.
- **Triggers** `gmail.email.received` (`includeSentByMe`, `filter`) and `gmail.email.labelReceived` (`labelId`, `includeSentByMe`, `filter`). Both are unavailable on servers without the Pub/Sub settings; actions work without them.
- **Actions:**
  - `gmail.sendEmail`: to/cc/bcc/reply-to, subject, text, optional HTML → multipart/alternative.
  - `gmail.replyToEmail`: keeps `threadId`, sets `In-Reply-To` / `References` and a single "Re:", replies to Reply-To/From; reply-all adds To/Cc minus our own mailbox.
  - `gmail.getEmail`, `gmail.addLabel`, `gmail.removeLabel`, `gmail.markAsRead`, `gmail.markAsUnread`.
  - Side effects: send/reply non-idempotent; label/read idempotent; get is a read. AC-15.9 table and Part 15 doc updated. Provider slot group: `gmail`.
- **Error mapping** (`mapGmailError`): 401 → refresh + retry; 403 `insufficientPermissions` → `PROVIDER_AUTH` / `PERMISSION_CHANGED`; 403 rate / quota and 429 → `PROVIDER_RATE_LIMIT` with `Retry-After`; 404 → permanent (history 404 → gap procedure); 5xx → retry, except a send, where it is `UNCERTAIN_OUTCOME`.
- **Picker:** `GET /workspaces/:ws/integrations/:connectionId/gmail/labels` (id, name, type).
- **Settings:** `GOOGLE_CLIENT_ID/SECRET`, `GOOGLE_*_URL`, `GMAIL_API_URL`, `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_AUDIENCE`, `GMAIL_PUSH_SERVICE_ACCOUNT`, `GMAIL_WATCH_RENEW_WITHIN_HOURS`, `GMAIL_DAILY_SEND_CAP_PER_WORKSPACE`, `GMAIL_MAX_BODY_CHARS`. Migration `20261005150000_gmail` adds the `GMAIL` provider key; watches reuse `ProviderSubscription`.

**Decisions**
- **Shared mailbox:** a notification routes to every connection subscribed to that mailbox. Each resolves history with its own credentials and history position and creates runs only for its own workspace's triggers. `users.stop` is called only when no other connection still watches the mailbox, because Gmail keeps one watch per user and topic.
- **No backfill after a history gap** (default; bounded catch-up not built).
- **Acknowledgement:** Gmail runs use `triggerSource = WEBHOOK` (push-driven). The intake answers 202, not 204; Pub/Sub accepts any 2xx.
- **Not built:** the optional shared trigger-status endpoint.

**Found while testing**
- **Retries:** label, read-state, watch and stop calls were classified like a send, so a Gmail 5xx became `UNCERTAIN_OUTCOME` instead of being retried. They are idempotent; only `messages.send` is now treated as a write that may have happened.

**Verification**
- Unit: `src/modules/integrations/gmail/gmail.spec.ts`, 16 tests covering:
  - address validation and header injection; RFC 2047; text+HTML MIME; reply subject;
  - text/HTML extraction, caps, attachments by name only;
  - the error table;
  - OIDC verifier with a real RS256 key (valid, wrong issuer / audience / service account / unverified / expired, tampered, HS256, unknown key, missing; key caching);
  - push adapter; trigger filters; config validation, routing and availability.
  - Full unit suite: 53 suites / 759 tests.
- Integration: `test/integration/gmail.int-spec.ts`, 20/20 against `FakeGoogle` (OAuth + PKCE, JWKS-signed push tokens, Gmail v1 with paged history and an expiry point):
  - connect parameters and scope refusal;
  - watch on publish; verified push → one run with the minimised email (no attachment content, delivery payload minimal);
  - duplicate pushes and 3 concurrent resolutions after a rewind → no extra run;
  - history paging; self-sent skipped; label trigger with the union watch;
  - unauthenticated pushes → 401 with nothing stored; history 404 → gap and restart, then normal;
  - renewal keeps the history position; expired watch recovered with a catch-up run; 3 failures → `WATCH_RENEWAL_FAILED`, then healed;
  - shared mailbox across two workspaces (runs per workspace, watch not stopped while shared);
  - all seven actions (MIME, threading, reply-all without self, labels, read state); header injection never sent; send 5xx → one attempt, `UNCERTAIN_OUTCOME`; label 5xx retried; daily send cap;
  - labels picker; tenant isolation; revoked grant → `TOKEN_REVOKED`, healed by reconnect; disconnect stops, revokes and deletes;
  - body / subject / token canaries absent from logs.

- Full integration suite: 26 suites, 412 tests, green on the first run (including Jira, Microsoft, webhooks and the route inventory).

## Google Cloud setup guide (real mailbox)

1. In a Google Cloud project, enable the **Gmail API** and **Pub/Sub API**.
2. OAuth consent screen: External, **testing** mode; add your mailbox as a test user. Credentials → OAuth client ID (Web application) with redirect URI `https://<public-url>/api/v1/integrations/gmail/callback`.
3. Pub/Sub:
   - create topic `gmail-push` and grant **Publisher** to `gmail-api-push@system.gserviceaccount.com`;
   - create a service account for push auth (e.g. `gmail-push@<project>.iam.gserviceaccount.com`);
   - create a **push** subscription to `https://<public-url>/api/v1/webhooks/gmail` with authentication enabled (that service account, audience `https://<public-url>/api/v1/webhooks/gmail`).
4. Set:
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`;
   - `OAUTH_REDIRECT_BASE_URL=https://<public-url>/api/v1/integrations`;
   - `GMAIL_PUBSUB_TOPIC=projects/<project>/topics/gmail-push`;
   - `GMAIL_PUSH_AUDIENCE=https://<public-url>/api/v1/webhooks/gmail`;
   - `GMAIL_PUSH_SERVICE_ACCOUNT=gmail-push@<project>.iam.gserviceaccount.com`.
5. Connect Gmail, publish "Gmail new email → Slack", send an email to the mailbox, and observe the run. Then run the send / reply actions (Scenarios 1 and 2 for AC-26.6).

| AC | Status |
| --- | --- |
| AC-26.1 | Met (mock-provider integration) |
| AC-26.2 | Met (integration, incl. duplicates and concurrency) |
| AC-26.3 | Met (integration; expiry simulated by setting `expiresAt`) |
| AC-26.4 | Met (integration) |
| AC-26.5 | Met (canaries + minimised storage) |
| AC-26.6 | **Partial**: Scenario 1 passed with a real mailbox; Scenario 2's Gmail trigger verified live, its AI step not run live (no Anthropic key; Jira and Slack actions verified live in their own parts) — [Real Gmail E2E](#real-gmail-e2e-2026-10-04) |

## Real Gmail E2E (2026-10-04)

Against the developer's running backend (API + worker) and a real Google Cloud project (OAuth client in testing mode, Pub/Sub topic + authenticated push subscription), public URL via ngrok; a throwaway FlowForge user/workspace created through the API. The operator only gave OAuth consent and sent emails; everything else was driven through the API and checked in the database.

| Step | Result |
| --- | --- |
| Provider status | `GMAIL configured: true` once the backend was restarted with the variables (env is read at startup) |
| Connect | Google consent (PKCE S256, `access_type=offline`, `prompt=consent`) → callback → connection `CONNECTED`, label = the mailbox, scopes `gmail.modify`, `gmail.send`, `userinfo.email`, `openid` |
| Labels picker | 18 labels returned (system + user) |
| Watch on publish | Publishing "Gmail new email → util.log" created the `mailbox` subscription: `users.watch` accepted, `INBOX`, expiry +7 days, start history id stored |
| Push → runs | First pushes did not arrive: the Pub/Sub push subscription was misconfigured on the Google side (fixed by the operator; FlowForge returned 401 to unsigned requests throughout). After the fix Pub/Sub redelivered the queued notifications: 5+ pushes `PROCESSED`, OIDC-verified → **4 runs for 4 inbox messages, all SUCCEEDED, 0 duplicates**; a 5th run later for a newly arrived message |
| Self-sent mail | The actions test's own send and reply (from the mailbox itself) created **no** trigger runs, as designed |
| All seven actions | One manual run, every email addressed only to the operator's own mailbox: `sendEmail` → `getEmail` (minimised message) → `addLabel STARRED` → `removeLabel STARRED` → `markAsRead` → `markAsUnread` → `replyToEmail` (same thread, `inReplyTo` set). All 8 steps SUCCEEDED, attempt 1; label/read state confirmed by Gmail's responses |
| Scenario 1 (daily operations) | `schedule.trigger` every 5 min (Africa/Johannesburg) → `http.request` GET `https://api.github.com/repos/nodejs/node` → condition `status == 200` → `gmail.sendEmail` report. Occurrence 09:45:00Z → run queued 22 s later (`triggerSource SCHEDULE`), fetch 200, condition true, report sent, false branch SKIPPED. Workflow archived afterwards (schedule inactive) |
| Scenario 2 (email triage) | Gmail trigger verified live (above). The AI classify/extract step was not run live: no Anthropic API key (Part 22 deferral). `jira.createIssue` verified live in Part 25, Slack in Part 13 |

Setup note: the push subscription's **endpoint** is `https://<public-url>/api/v1/webhooks/gmail`; its **audience** may be any string as long as it equals `GMAIL_PUSH_AUDIENCE`.

