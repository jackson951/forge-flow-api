# 24 — Generic HTTP: Outbound Requests and Inbound Triggers (Custom API)

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

## Objective

Make FlowForge talk HTTP in **both directions**, robustly:

- **Outbound — `http.request` action:** call any HTTP/REST API (method, URL, headers, query, body, timeout, authentication) with templated values from earlier steps, a normalised response (`{{steps.create_ticket.output.body.ticketId}}`), honest error classification/retries, and **SSRF protection strong enough for a multi-tenant service**.
- **Inbound — external triggers:** any external system can start a workflow through a **generic webhook trigger** (`webhook.received`: unique URL, several verification modes, replay protection, dedup, filters, rate limits, delivery log, test capture), and APIs that cannot push can be watched with an **HTTP polling trigger** (`http.poll`: scheduled request + change detection → one run per new item).

## Why This Part Exists

Dedicated connectors cover a handful of tools; a generic HTTP action makes FlowForge useful with everything else. Because users choose the destination, this is also the part with the largest new attack surface: until now FlowForge deliberately had **no user-configurable outbound URL** (Part 18 FR-18.7, enforced by `src/engine/catalog/no-outbound-urls.spec.ts`). This part replaces that "no URLs at all" guarantee with an explicit, tested egress policy.

## Existing architecture this part builds on (inspected 2026-10-03)

| Component | Today | Gap / change |
| --- | --- | --- |
| Part 18 SSRF policy | Written for "any future configurable HTTP": HTTPS only, DNS resolve + reject private/loopback/link-local/CGNAT/metadata/IPv6 equivalents, re-check redirects, pin IP, size/time limits, per-workspace allow-list | Implemented here (see decision on plain HTTP) |
| `no-outbound-urls.spec.ts` | Fails if any node config accepts a URL/host | Updated deliberately: `http.request` is the single allowed exception, and the test asserts it goes through the egress guard |
| Expressions (`engine/expressions/mapping.ts`) | `{{ ref }}` templates (16 KB rendered cap) and `{ ref }` typed values, single pass, no eval | Reused for URL/headers/query/body — no second interpolation engine |
| Credentials (`IntegrationCredential`) | `encryptedAccessToken`, `encryptedRefreshToken`, AES-256-GCM with AAD (Part 17) | Needs a structured encrypted payload (username/password, header name/value, query param) |
| `IntegrationConnection` | `@@unique(workspaceId, provider, externalAccountId)`, OAuth-created | API-key style connections created through a create/test endpoint; `externalAccountId` = generated id so many per workspace |
| Webhook platform (Part 09) | `POST /webhooks/:provider`, app-level secrets, delivery dedup `@@unique(provider, deliveryId)`, async run creation | **No per-workflow generic webhook trigger exists** — added here on the same pipeline |
| Provider concurrency (`provider-slots.ts`) | prefixes `github`, `slack`, `microsoft`, `ai` | add `http` (limit per worker; per-host fairness considered) |
| Run queue backoff | honours provider `Retry-After` (Part 13) | reused for 429/503 |

## Scope

1. `http.request` action node.
2. HTTP connections (credential-based, no OAuth): none / bearer / basic / API key in header / API key in query / custom secret headers.
3. Egress guard (SSRF) used by the action, the polling trigger and connection tests.
4. Error classification + retry semantics.
5. Generic inbound webhook trigger `webhook.received` (audit result: missing) on the Part 09 pipeline — robust verification, dedup, filtering, limits, observability.
6. HTTP polling trigger `http.poll` on the Part 23 scheduler.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-24.1 | `http.request` config: `method` (GET, POST, PUT, PATCH, DELETE; HEAD optional), `url` (template allowed), `query` (key → template), `headers` (key → template; hop-by-hop and `Host`, `Content-Length`, `Transfer-Encoding`, `Cookie`* rejected or overwritten), `body` (`none` \| `json` (any JSON with templates/`{ref}`) \| `text` \| `form`), `timeoutMs` (1 000–30 000, default 10 000), `connectionId` (optional uuid; required for authenticated calls), `followRedirects` (default true, max 3), `responseType` (`auto` \| `json` \| `text`). |
| FR-24.2 | Secrets never in node config: the graph validator's `SECRET_IN_CONFIG` check applies; header names like `Authorization`, `X-Api-Key`, `Cookie` in plain config are rejected with "use an HTTP connection". |
| FR-24.3 | Normalised output: `{ status, statusText, headers (lower-cased, allow-listed or size-capped, secrets removed), body (parsed JSON or text, capped), bodyTruncated?, durationMs, finalUrl (without credentials/query secrets) }`. Readable as `{{steps.<key>.output.body.<field>}}`. |
| FR-24.4 | HTTP connection types (multiple per workspace, each named): `bearer` {token}, `basic` {username, password}, `apiKeyHeader` {headerName, value}, `apiKeyQuery` {paramName, value}, `customHeaders` {name → secret value, ≤ 10}. Optional non-secret `baseUrl` and `allowedHosts` restriction per connection. Created with `POST /workspaces/:ws/integrations/http` (ADMIN), tested with `POST …/integrations/:connectionId/test` (makes a request to a user-given URL through the same egress guard), renamed/rotated with PATCH/PUT, deleted with the existing DELETE. Secrets write-only. |
| FR-24.5 | Status classification (see Error Handling) mapped to existing `ErrorCategory` values; retryable errors re-queue with backoff honouring `Retry-After`; non-idempotent methods (POST, PATCH) that may have reached the server (timeout after send, connection reset after send) are `UNCERTAIN_OUTCOME` and not auto-retried (Part 15 rules). GET/HEAD/PUT/DELETE are treated as idempotent for automatic retry; a node option `idempotent: true` for POST is considered (decision). |
| FR-24.6 | Limits: request body ≤ 1 MB after rendering, response read ≤ 1 MB (configurable, default 512 KB stored, larger → `bodyTruncated` or `RESPONSE_TOO_LARGE` error by option), header count/size caps, total time ≤ timeout. |
| FR-24.7 | **Generic webhook trigger — endpoint.** Publishing a workflow whose trigger is `webhook.received` provisions a unique endpoint `/api/v1/webhooks/hooks/:hookId` (`hookId` = 128-bit random, URL-safe; stored as a hash/indexed value, never derivable from ids). Accepted methods configurable (`POST` default; `PUT`, `PATCH`, `GET` optional — GET carries data in the query). The URL survives new versions; it changes only when rotated. Unpublished/archived workflows answer `404` (no information leak about existence). |
| FR-24.8 | **Verification modes** (per trigger, chosen in config, secrets generated by FlowForge and stored encrypted, shown once to ADMIN): `none` (allowed only with an explicit warning); `token` — shared secret in a header (`X-FlowForge-Token` default, header name configurable) or `Authorization: Bearer`; `basic` — username/password; `hmac` — HMAC over the **raw body** with configurable algorithm (`sha256` default, `sha1`/`sha512` for compatibility), header name, encoding (hex/base64) and prefix (e.g. `sha256=`), optional **timestamp header + signed `timestamp.body` scheme** with a replay window (default 5 min) — covers GitHub/Stripe/Slack-style senders; optional **IP allow-list** (CIDR list) in addition to any mode. All comparisons constant-time; failures → `401` with a generic body, logged with reason (not secrets). |
| FR-24.9 | **Secret rotation with grace period:** rotating creates a new secret; the previous one stays valid for a configurable grace window (default 24 h) so senders can be updated without downtime; both are listed (hint only) until the old one expires. URL rotation likewise optional with grace. |
| FR-24.10 | **Payload handling:** content types JSON, `application/x-www-form-urlencoded`, `text/plain`, and raw text for XML/other (stored as text, size-capped); body limit default 256 KB (operator max 1 MB) → `413`; malformed JSON → `400`; headers stored only from an allow-list plus configured extra headers (never `Authorization`/`Cookie`/signature headers); query string parsed. Trigger output: `{ method, headers, query, body, rawText?, contentType, receivedAt, deliveryId, sourceIp? }`. |
| FR-24.11 | **Deduplication / idempotency:** delivery id taken from a configurable source — a header (`Idempotency-Key`, `X-Request-Id`, `X-GitHub-Delivery`, …) or a JSON path in the body (e.g. `event.id`); else a generated id (every request distinct). Deduped through the existing `WebhookDelivery @@unique(provider, deliveryId)` scoped per hook (`deliveryId = <hookId>:<value>`); a duplicate returns the same `202` (with the original run id when known) and creates nothing. Senders' automatic retries are therefore safe. |
| FR-24.12 | **Filtering before a run:** optional conditions on headers/query/body (the Part 11 condition grammar, no code) decide whether a delivery starts a run; non-matching deliveries are stored as `IGNORED` with the reason (keeps noise out of run history). |
| FR-24.13 | **Response contract:** always fast acknowledgement (target p95 < 200 ms, no synchronous workflow execution): `202 { accepted: true, deliveryId, runId? }`; configurable static response status (200/202/204) and small static JSON body for senders that require a specific reply; a `GET` verification/challenge echo mode (e.g. `?challenge=` → echo) for senders that validate endpoints on setup. |
| FR-24.14 | **Abuse protection:** per-hook and per-source-IP rate limits (Redis-backed, Part 18 infrastructure) → `429` with `Retry-After`; per-workspace daily delivery cap; backpressure (Part 21) applies to run creation — over the threshold deliveries are still accepted and stored, runs created when the queue drains (never dropped silently) — or rejected with `503` + `Retry-After` by config (decision). |
| FR-24.15 | **Delivery log & test capture:** `GET /workspaces/:ws/workflows/:id/webhook/deliveries` (ADMIN/MEMBER read) lists recent deliveries with status (ACCEPTED/DUPLICATE/IGNORED/REJECTED + reason, never secrets), size, time, run link; ADMIN can **replay** a stored delivery (creates a new run, marked as replay). A **"listen for a test event"** mode (draft workflows, 10 min) captures the next delivery's payload so the editor can offer `{{ trigger.body.* }}` suggestions without publishing. |
| FR-24.16 | **HTTP polling trigger `http.poll`** for APIs without webhooks: config = request (same shape as `http.request`, through the egress guard, optional `connectionId`), schedule (Part 23 kinds, minimum 1 min), item extraction (JSON path to an array, or the whole response as one item), item identity (JSON path to an id field, or a content hash), optional cursor (JSON path of a "since"/next token fed into the next request via `{{ poll.cursor }}`). On each occurrence the poller fetches, extracts items, and creates **one run per new item** (dedup by `pollId:itemId` through the unique run idempotency key), first poll seeds state without firing (configurable). State (`lastCursor`, seen-id window or high-water mark) persisted per trigger. Errors follow the outbound classification; repeated failures mark the trigger `FAILING` (visible) and back off. |

## Technical Requirements

- **Egress guard** (`src/infrastructure/egress/`): parse with WHATWG URL; scheme allow-list; reject userinfo in URL; resolve **all** A/AAAA records with `dns.lookup({ all: true })`; reject if **any** address is in a blocked range; connect to the vetted IP (custom `lookup` in the HTTP agent / undici `connect` hook) with SNI/Host of the original name — so a DNS rebinding between check and connect cannot reach a different address; redirects followed manually (max 3) and every hop re-validated; blocked ranges include 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16 (incl. 169.254.169.254 and the IPv6 metadata fd00:ec2::254), 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4, ::/128, ::1, fc00::/7, fe80::/10, IPv4-mapped IPv6 of the above; non-default ports allowed except a configurable deny list (e.g. 25, 6379, 5432) — decision; internal service names (`postgres`, `redis`, `api`, `worker`, `localhost`, `*.internal`, `*.local`) rejected by name before resolution as defence in depth.
- Operator overrides via env: `HTTP_ACTION_ENABLED`, `HTTP_ACTION_ALLOW_PLAIN_HTTP` (default false in production), `HTTP_ACTION_ALLOW_PRIVATE_NETWORKS` (default false; for self-hosted deployments that intentionally call internal APIs), global host deny/allow lists.
- Requests made only in the worker; streaming body read with byte caps; `AbortSignal` timeout; no cookies jar; `Accept-Encoding` handled with decompressed-size cap (zip bombs).
- Templates rendered with the existing mapping (`renderTemplate` / `mapConfig`); URL rendered first then re-validated by the guard (a template can never bypass it).
- Logging through the existing redactor: never log Authorization, Cookie, Set-Cookie, API-key headers/params, connection secrets or full bodies; log method, host, path (query values redacted), status, duration, size.

## API Requirements

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/node-types` | adds `http.request`, `webhook.received` |
| GET | `/integrations/providers` | adds `HTTP` (connection type `CREDENTIALS`, always configured) |
| POST | `/workspaces/:ws/integrations/http` | ADMIN; create HTTP connection `{ name, authType, secret fields, baseUrl?, allowedHosts? }` → connection metadata only |
| POST | `/workspaces/:ws/integrations/:connectionId/test` | ADMIN; `{ url, method? }` through the egress guard → `{ ok, status?, category? }`; rate limited |
| PATCH | `/workspaces/:ws/integrations/:connectionId` | rename / non-secret settings |
| PUT | `/workspaces/:ws/integrations/:connectionId/credentials` | rotate secrets (write-only) |
| DELETE | `/workspaces/:ws/integrations/:connectionId` | existing |
| POST/PUT/PATCH/GET | `/webhooks/hooks/:hookId` | public, generic inbound webhook (FR-24.7–24.14) |
| GET | `/workspaces/:ws/workflows/:id/webhook` | URL, verification mode, secret hints, status |
| POST | `/workspaces/:ws/workflows/:id/webhook/rotate-secret` / `rotate-url` | ADMIN; new secret shown once, old valid for the grace period |
| GET | `/workspaces/:ws/workflows/:id/webhook/deliveries` | delivery log (FR-24.15) |
| POST | `/workspaces/:ws/workflows/:id/webhook/deliveries/:deliveryId/replay` | ADMIN |
| POST | `/workspaces/:ws/workflows/:id/webhook/listen` | ADMIN/MEMBER on drafts; capture one test payload (FR-24.15) |
| GET | `/workspaces/:ws/workflows/:id/poll` | polling trigger state (last poll, status, items seen) |

Endpoint shapes follow the existing integrations controller conventions; final paths confirmed in implementation. This credential-based create/test pattern is the one any future API-key provider would reuse.

## Database / persistence changes

- `IntegrationProviderKey` + `HTTP` (and `WEBHOOK` for the generic trigger routing, or a dedicated table — decide).
- `IntegrationCredential.encryptedPayload` (nullable, AES-GCM JSON of the auth secrets) — or reuse `encryptedAccessToken` with a JSON envelope (decide; a separate column is clearer).
- `IntegrationConnection.metadata` holds non-secret auth type, header/param names, base URL, allowed hosts, secret hints (`…a1b2`).
- `IntegrationConnection.statusReason` (enum: `TOKEN_REVOKED`, `TOKEN_EXPIRED`, `APP_UNINSTALLED`, `PERMISSION_CHANGED`, `WATCH_RENEWAL_FAILED`, `AUTHENTICATION_FAILED`) — introduced here, reused by Parts 25/26 and the existing providers.
- Generic webhook: `WorkflowWebhook` (`workflowId @unique`, `workspaceId`, `hookIdHash` unique, previous `hookIdHash` + expiry for URL rotation grace, `verification` config (non-secret), `encryptedSecret`, `previousEncryptedSecret` + `previousSecretExpiresAt`, `ipAllowList`, `rateLimit`, `filter Json`, `response Json`, `createdAt`, `rotatedAt`), routing to the workflow's active version; deliveries stored in `WebhookDelivery` (provider `WEBHOOK`, `deliveryId = <hookId>:<source id>`, status incl. `IGNORED`/`REJECTED` + reason, normalised size-capped payload for replay and the log; retention per Part 21).
- Test capture: short-lived `WebhookTestCapture` (draft workflow, expiresAt, payload) or Redis with TTL (decision).
- Polling: `HttpPollState` (`workflowId @unique`, `workspaceId`, `lastPolledAt`, `lastCursor`, `seenItemIds` bounded window or high-water mark, `consecutiveFailures`, `status`); occurrences driven by `WorkflowSchedule` (Part 23).

## Security Requirements

- Threat model (documented in this file before coding): SSRF to metadata/internal services, DNS rebinding, redirect to internal, IPv6/IPv4-mapped tricks, decimal/octal/hex IP encodings (handled by URL parser + resolution), port scanning via timing (rate limit + uniform errors), credential exfiltration to attacker hosts (connection `allowedHosts`), response-based data exfiltration of internal pages (blocked by egress), header injection (CR/LF rejected), request smuggling (managed client only), zip bombs, slowloris responses (total timeout).
- Secrets: encrypted at rest (Part 17 envelope, AAD bound to connection id), write-only API, redacted in logs, never in run/step data (`input` stored with auth headers removed).
- Generic webhook: unguessable id, constant-time verification (token/basic/HMAC), replay window for timestamped signatures, optional IP allow-list, body/header limits, per-hook and per-IP rate limits, generic error bodies (no oracle for valid ids or which check failed), secret rotation with grace, no raw secrets/signatures stored in deliveries.
- Polling trigger: same egress guard and connection rules as `http.request`; minimum interval and per-workspace poll quota to avoid abusing third parties.
- Least privilege: only ADMIN creates connections and webhooks; MEMBERs can use existing connections in drafts; publish checks connection ownership (existing `checkConnections`).

## Multi-Tenant Requirements

- `connectionId` resolved with `{ id, workspaceId: run.workspaceId, provider: HTTP }` at publish and at execution; a foreign id fails as "connection not found".
- Webhook `hookId` maps to exactly one workflow in one workspace.
- Tenant-isolation suite covers every new route.

## Error Handling

| Condition | Category | Retry |
| --- | --- | --- |
| DNS failure (NXDOMAIN) | `PERMANENT_PROVIDER_ERROR` | no |
| DNS timeout / connection refused / reset before send | `TRANSIENT_INFRASTRUCTURE` | yes |
| Blocked destination (SSRF guard) | `VALIDATION` ("destination not allowed") | no |
| Timeout after request sent (POST/PATCH) | `UNCERTAIN_OUTCOME` | no (acknowledged retry only) |
| Timeout (idempotent methods) | `PROVIDER_TIMEOUT` | yes |
| 401 / 403 | `PROVIDER_AUTH` → connection `NEEDS_ATTENTION (AUTHENTICATION_FAILED)` after repeated failures | no |
| 404, 400, 409, 422, other 4xx | `PERMANENT_PROVIDER_ERROR` (status in message) — option `failOn4xx: false` to return the response as output instead | no |
| 429 | `PROVIDER_RATE_LIMIT`, honour `Retry-After` | yes |
| 5xx | `TRANSIENT_INFRASTRUCTURE` (idempotent) / `UNCERTAIN_OUTCOME` for 502/504 after non-idempotent send — decide | yes / no |
| Invalid JSON with `responseType: json` | `PERMANENT_PROVIDER_ERROR` | no |
| Response too large | `PERMANENT_PROVIDER_ERROR` (`RESPONSE_TOO_LARGE`) | no |

## Observability

Per call: method, host, path template (not values), status, duration, request/response bytes, attempt, category, redirect count, `runId`, `nodeKey`, `correlationId`. Counters per host for 429/5xx; egress-blocked counter (security signal). Never secrets or bodies.

## Testing Requirements

- Unit: egress guard (every blocked range, IPv6, mapped addresses, encodings, internal names, ports), redirect re-validation, error classification table, header sanitisation, secret detection in config.
- Integration with a **controlled local test service** (spun up in the test, bound to an allowed test address via the guard's test override, never a real private-range bypass in production config): GET/POST/PUT/PATCH/DELETE, query, JSON/text/form bodies, headers, bearer/basic/API-key header/query/custom headers, templating from trigger and steps, timeouts, 429 + Retry-After, 5xx retry, redirects (allowed and to-private blocked), large response truncation/error, secret redaction in logs and step data, cross-workspace connection rejection (publish + execution), connection create/test/rotate/delete.
- DNS edge cases with a stub resolver: multiple records with one private, rebinding (first public then private), AAAA-only.
- Generic webhook: each verification mode ok/bad (token, basic, HMAC sha1/sha256/sha512 hex/base64 with prefix), timestamped signature inside/outside the replay window, IP allow-list, secret rotation grace (old accepted until expiry, then rejected), every content type, body too large (413), malformed JSON (400), dedup by header and by JSON path (concurrent duplicates → one run), filter → IGNORED, rate limit → 429, backpressure behaviour, custom response, challenge echo, unknown/archived hook → 404 without leaking, delivery log + replay, test capture on a draft, async run through the queue.
- Polling trigger: first poll seeds without firing, new items → one run each, repeated items never re-fire (also across two evaluators), cursor propagation, item id vs hash identity, provider errors and backoff, egress guard applied.
- `no-outbound-urls.spec.ts` updated: only `http.request` may accept a URL and must route through the guard (architecture test).

## E2E Scenarios

- **S24.1** Manual trigger → `http.request` POST to the local test service with `{{ trigger.customerId }}` → condition on `{{ steps.call.output.status }}` → `util.log` → SUCCEEDED.
- **Scenario 4 — Universal API:** `webhook.received` → `http.request` → condition → Slack (Jira/Gmail once Parts 25/26 exist).
- **Scenario 1 — Daily operations** (with Part 23): schedule → HTTP fetch → condition → (Gmail after Part 26; Slack/log before).

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-24.1 | All methods, templating, auth types and normalised output work against the local test service | Integration tests |
| AC-24.2 | Every SSRF case in the threat model is blocked, including DNS rebinding and redirect-to-private | Unit + integration tests |
| AC-24.3 | Errors are classified per the table; 429 honours Retry-After; non-idempotent uncertain outcomes are not auto-retried | Integration tests |
| AC-24.4 | Secrets never appear in workflow JSON, API responses, logs or run/step data | Secret canary suite + log assertions |
| AC-24.5 | A connection of another workspace cannot be used (publish and execution) | Tenant-isolation tests |
| AC-24.6 | Generic webhook: every verification mode, replay protection, IP allow-list and rotation grace behave as specified; duplicates create one run; filters, limits and backpressure behave as specified; acknowledgement is fast and execution asynchronous | Integration + E2E |
| AC-24.8 | Delivery log shows accepted/duplicate/ignored/rejected deliveries without secrets; replay and test capture work | Integration tests |
| AC-24.9 | `http.poll` creates exactly one run per new item across restarts and concurrent evaluators | Integration tests with the local test service |
| AC-24.7 | Scenario 4 passes end to end through queue/worker/engine | E2E |

## Definition of Done

Roadmap DoD plus all AC with evidence; threat model reviewed; Part 18 SSRF section updated to point to the implementation.

## Dependencies

Parts 09 (webhook pipeline), 11 (expressions, conditions for webhook filters), 15 (side-effect classes), 17 (credential encryption), 18 (SSRF policy, rate limits), **23 (scheduler — required by `http.poll`)**. This is why Schedule comes before HTTP in the order.

## Out of Scope

GraphQL helpers, multipart file upload, pagination helpers, OAuth-client-credentials auth for arbitrary APIs, mTLS client certificates, response transformation scripts (no code execution), SOAP.

## Risks / Design Questions

- **Plain HTTP:** Part 18 says HTTPS only; the request asks for HTTP/HTTPS. Proposal: HTTPS always; HTTP only when `HTTP_ACTION_ALLOW_PLAIN_HTTP=true` (dev/self-hosted). Needs a product decision.
- **Private networks for self-hosters** (`HTTP_ACTION_ALLOW_PRIVATE_NETWORKS`) — off by default; document the risk.
- Port policy (allow all public ports vs allow-list).
- POST retry semantics (`idempotent` flag / `Idempotency-Key` header forwarding).
- Storing response bodies in step output (retention, size) — default cap 512 KB.
- Webhook overload policy: accept-and-store vs `503` when the run queue is saturated.
- Test-capture storage (table vs Redis TTL) and whether MEMBERs may start a capture.
- Polling state for very large item lists (seen-id window size vs high-water mark requirement).

## Implementation Notes

- Use undici (`Agent` with a `connect` hook) or Node `http(s)` with a custom `lookup` that returns only the vetted address; avoid libraries that follow redirects internally.
- The guard is a separate module with no framework dependency, tested exhaustively; providers' fixed base URLs keep bypassing it (server configuration).
