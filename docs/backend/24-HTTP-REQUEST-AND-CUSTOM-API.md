# 24 — Generic HTTP: Outbound Requests and Inbound Triggers (Custom API)

**Status:** IN PROGRESS: all three slices implemented (outbound, `webhook.received`, `http.poll`). Before COMPLETE: the CI run on the PR and a live check against a real API (see the end of this file) (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

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

## Threat model (outbound, slice 1)

This was written while implementing slice 1, not before coding as the DoD asks. It is reviewed here against the code and the tests.

| Threat | Mitigation | Test |
| --- | --- | --- |
| SSRF to cloud metadata / internal services | The URL host is checked statically. Then every A/AAAA record is resolved, and if any address is in a blocked range the request is refused. Blocked ranges include 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, documentation nets, 192.168/16, 198.18/15, 224/4, 240/4, ::, ::1, 64:ff9b::/96, fc00::/7 (incl. fd00:ec2::254), fe80::/10 and ff00::/8. | `egress-policy.spec`, `egress-client.spec` |
| IPv4-mapped / compatible IPv6, NAT64 | Embedded IPv4 is extracted and checked; NAT64 is blocked. | `egress-policy.spec` |
| Decimal / octal / hex / short IP forms | The WHATWG URL parser normalises them, then they are checked as literals. | `egress-policy.spec` |
| Internal names (`postgres`, `redis`, `api`, `localhost`, `*.internal`, `*.local`, single-label) | Refused by name before any lookup. | `egress-policy.spec` |
| DNS rebinding | The name is resolved once and the socket is pinned to the vetted address (custom `lookup`, TLS SNI = original name). A second answer is never used. | `egress-client.spec` |
| Redirect to internal | Redirects are followed by hand (max 3) and every hop is re-checked. 303 (and 301/302 after POST) becomes GET. | `egress-client.spec`, `http.int-spec` |
| Credential exfiltration to attacker hosts | Credentials are dropped on cross-origin redirects. The connection's `allowedHosts` is checked on every hop, before any byte is sent. | `egress-client.spec`, `http.int-spec` |
| Secrets in workflows / step data / logs | Credential headers are refused in node config (FR-24.2). Auth is applied only inside the handler, so step input never holds it. Connection secret values are scrubbed from stored output, plain and URL-encoded. Logs carry scheme, host, path and query keys only. | `http.spec`, `http.int-spec` (canaries) |
| Header injection / request smuggling | CR/LF/NUL are refused in names and values (config and rendered). Framing and hop-by-hop headers are reserved. Only Node's own HTTP client is used. | `http.spec` |
| Zip bombs, huge or slow responses | Bytes are counted after decompression and capped (`HTTP_ACTION_MAX_RESPONSE_BYTES`). There is a total time limit across redirects, and the engine's AbortSignal is honoured. | `egress-client.spec` |
| Port scanning / abuse of internal ports | Denied ports by default (25, 465, 587, 2375, 2376, 5432, 6379, 9200, 11211, 27017). The connection test is rate limited (10/min) and returns only the outcome, never the body. Errors are uniform. | `egress-policy.spec`, `http.int-spec` |
| Reading internal pages through the test endpoint | The test endpoint returns `{ ok, status, category }` only. | `http.int-spec` |

## Implementation Evidence: slice 1 (outbound), 2026-10-04

**Delivered**
- Egress guard `src/infrastructure/egress/`:
  - `egress-policy.ts` (pure policy) and `egress-client.ts` (resolve-all, pin, manual redirects, caps, decompression limit, timeout);
  - a global `EgressModule`;
  - a test allowance (`allowForTests`, refused unless `NODE_ENV=test`). It can also answer one test host name locally, so static checks see an ordinary public host while only the local test service is reachable.
- Settings: `HTTP_ACTION_ENABLED`, `HTTP_ACTION_ALLOW_PLAIN_HTTP` (default false), `HTTP_ACTION_ALLOW_PRIVATE_NETWORKS` (default false), `HTTP_ACTION_DENIED_PORTS`, `HTTP_ACTION_DENIED_HOSTS`, `HTTP_ACTION_MAX_RESPONSE_BYTES` (1 MB), `HTTP_ACTION_MAX_STORED_BODY_BYTES` (48 KB).
- HTTP connections (`IntegrationProviderKey.HTTP`):
  - auth types `bearer`, `basic`, `apiKeyHeader`, `apiKeyQuery`, `customHeaders` (up to 10), plus optional `baseUrl` and `allowedHosts`;
  - secrets are sealed in the new `IntegrationCredential.encryptedPayload` (AAD `<connectionId>:payload`, included in key rotation `reencryptAll`);
  - metadata shows only the auth type, header/param names and a hint of the last 4 characters;
  - migration `20261004090000_http_connections`.
- Routes (all ADMIN):
  - `POST /workspaces/:ws/integrations/http`
  - `POST .../integrations/:connectionId/test` (rate limited, outcome only)
  - `PATCH .../integrations/:connectionId`
  - `PUT .../integrations/:connectionId/credentials`
  - delete uses the existing route.
- `GET /integrations/providers` lists `HTTP` with `connectionType: CREDENTIALS`; OAuth providers now report `connectionType: OAUTH`.
- `http.request` node type:
  - config per FR-24.1, plus `failOn4xx`, `idempotent` and `onLargeResponse`;
  - templates in url, query, header values and body;
  - static URLs are checked at validate/publish;
  - the connection is optional (`connectionOptional`, honoured by the publish connection check).
- Worker handler: classification per the Error Handling table, `Retry-After` honoured, `Idempotency-Key` sent for POST/PATCH marked `idempotent`. It is in the `http` provider-slot group and is declared `non-idempotent` in the AC-15.9 table and the Part 15 doc.
- `no-outbound-urls.spec.ts` was amended deliberately: `http.request.url` is the single allowed URL, and the test checks that the handler sends only through `egress.send(`. Part 18 FR-18.7 now points here.

**Decisions** (taken from this spec's own proposals)
- **Plain HTTP:** HTTPS only. HTTP is allowed only with `HTTP_ACTION_ALLOW_PLAIN_HTTP=true` (dev/self-hosted).
- **Private networks:** off by default (`HTTP_ACTION_ALLOW_PRIVATE_NETWORKS`), for self-hosters only.
- **Ports:** all public ports are allowed except the denied list.
- **POST/PATCH retries:** opt-in with `idempotent: true`, which sends `Idempotency-Key: <runId>:<nodeKey>`.
- **5xx after a POST/PATCH:** 503 and 429 are retried (the server says it did not process the request). 502, 504 and 500 count as `UNCERTAIN_OUTCOME` and are retried only on a human decision.
- **Stored body:** 48 KB by default, not the 512 KB the spec proposed. The engine stores at most 64 KB per step (Part 16); raising that would change storage and retention for every run. Up to 1 MB is read; larger bodies are truncated (`bodyTruncated`) or fail with `RESPONSE_TOO_LARGE` (`onLargeResponse: 'error'`).
- **401/403:** fail the step with `PROVIDER_AUTH` but do not mark the connection `NEEDS_ATTENTION` yet. `statusReason` and "after repeated failures" are deferred until Parts 25/26 add the shared status reason.

**Found and fixed while testing**
- A server that echoes the request URL (seen with the local echo service) returned an `apiKeyQuery` credential, which was being stored in the step output. The handler now scrubs the connection's own secret values from everything it stores (`scrubSecrets`).

**Verification**
- Unit tests:
  - egress policy and client: 53 tests (every blocked range, mapped IPv6 / NAT64, encodings, internal names, ports, DNS with a stub resolver, rebinding, redirects, credential stripping, decompression bomb, timeouts, abort);
  - HTTP model: 21 tests (config, auth types, URL resolution, bodies, Retry-After, the classification table, output normalisation, scrubbing).
  - Full unit suite: 49 suites / 683 tests.
- Integration: `test/integration/http.int-spec.ts`, 17/17 against a local test service reached only through the test allowance. It covers connection create/list/test/rotate/update/delete with write-only secrets; S24.1 (POST with templated JSON + bearer, then a condition on the status, then a log); all methods, query, headers, text/form bodies and relative URLs; every auth type; output normalisation and size caps; 429 + Retry-After and 5xx retry for GET; POST 5xx giving `UNCERTAIN_OUTCOME` with a single call; idempotent POST retried with the same key; 4xx with and without `failOn4xx`; redirect to metadata blocked; a templated URL rendering to a private address blocked; `allowedHosts` stopping credential exfiltration; secret canaries across steps, API responses, versions and logs; and a foreign-workspace connection refused at publish and at execution.
- Full integration suite: 22 suites, 333 tests. The first run failed 3 tests in existing suites because of this slice: the route authorization inventory did not list the 4 new routes, and the provider list now carries `connectionType`. Those tests were updated and re-run green (69/69).

| AC | Status |
| --- | --- |
| AC-24.1 | Met (integration) |
| AC-24.2 | Met for outbound (unit + integration); `http.poll` reuses the guard in slice 3 |
| AC-24.3 | Met (integration) |
| AC-24.4 | Met for outbound (canaries + log assertions) |
| AC-24.5 | Met (publish + execution) |
| AC-24.6, AC-24.8 | See slice 2 below |
| AC-24.9 | See slice 3 below |
| AC-24.7 | See slice 2 below |

## Implementation Evidence: slice 2 (generic inbound webhook), 2026-10-04

**Delivered**
- `webhook.received` trigger (`src/modules/hooks/`). Its strict config covers:
  - `methods` (POST, PUT, PATCH, GET);
  - `verification`: `none` (only with `acknowledgeUnverified: true`), `token` (header, or `Authorization: Bearer`), `basic`, or `hmac` (sha256/sha1/sha512, hex/base64, prefix, optional timestamp header with replay window in `{timestamp}.{body}` or `v0:{timestamp}:{body}` form);
  - `ipAllowList` (CIDR);
  - `deduplication` (header or JSON path);
  - `filter` (Part 11 condition grammar);
  - `response` (200/202/204 with an optional static JSON body up to 1 KB);
  - `challenge` (GET query echo);
  - `includeHeaders`;
  - `rateLimitPerMinute`.
- `WorkflowWebhook` table (migration `20261004150000_generic_webhooks`):
  - the URL is `/api/v1/webhooks/hooks/<hookId>`, a 128-bit random id; only its sha256 is indexed, and the id itself is kept sealed so admins can see the URL again;
  - the verification secret is sealed (AAD bound to the row);
  - previous hook id and previous secret are kept with expiry for rotation grace;
  - the stored config is a snapshot of the active version's trigger.
- Provisioning runs in the publish / archive / unarchive transactions (`TriggerRoutingService` → `HookProvisioner`). The URL survives new versions. A version with another trigger, archive, or a draft leaves the row inactive, and the URL answers 404.
- Intake (`HookIntakeService`), in this order:
  1. hook lookup (current or in-grace previous id) and live check;
  2. method check (405);
  3. challenge echo;
  4. per-hook and per-IP rate limits in Redis (429 + `Retry-After`; fails open if Redis is down);
  5. verification with constant-time compares against the current secret and the in-grace previous one (401, generic body, `REJECTED` row with the reason and no payload);
  6. body parse (JSON, form, text, others as `rawText`; 400 for malformed JSON; 413 above `WEBHOOK_HOOK_MAX_BODY_BYTES`);
  7. workspace daily cap;
  8. a transaction that inserts the delivery (unique `(WEBHOOK, <hookRowId>:src|gen:<id>)`), applies the filter (`IGNORED` + reason) and creates the run;
  9. enqueue after commit, then reply.

  Duplicates create nothing; they increment `duplicateCount` and get the original `runId`.
- Raw-body parser for `/api/v1/webhooks/hooks` (any content type, exact bytes for HMAC), registered before the provider webhook parser. Exactly POST/PUT/PATCH/GET are routed.
- Admin API under `/workspaces/:ws/workflows/:id/webhook`:
  - `GET`: URL, status, mode and secret hint. A generated secret is revealed once, to an admin, claimed atomically.
  - `POST rotate-secret` (ADMIN): generated or the sender's own secret; grace defaults to 24 h.
  - `POST rotate-url` (ADMIN): with grace.
  - `GET deliveries`: keyset paging; status, reason, size, IP, duplicate count, run; never the payload or secrets.
  - `POST deliveries/:id/replay` (ADMIN): new run, `replayOfDeliveryId`, audited.
  - `POST` / `GET listen`: 10-minute, one-shot capture for a workflow that is not live.
- Settings: `WEBHOOK_HOOK_MAX_BODY_BYTES` (256 KB), `WEBHOOK_HOOK_PER_IP_PER_MINUTE` (60), `WEBHOOK_HOOK_DAILY_CAP_PER_WORKSPACE` (10 000), `WEBHOOK_HOOK_ROTATION_GRACE_HOURS` (24), `PUBLIC_API_URL` (base of shown URLs; default: the request's host).
- Architecture tests updated: side-effect table (`webhook.received`: none), node-type URL check, paginated-list inventory, route authorization inventory.

**Decisions and limits**
- **Overload:** deliveries are always accepted and stored, and runs are created QUEUED. The database is the buffer, as for provider webhooks (Part 21). The optional "reject with 503" mode is not built.
- **Test capture** happens before verification, because a draft has no published verification config. It is one-shot, needs a member to start it, expires after 10 minutes, and is bounded by the body cap. MEMBERs may start a capture, since they can edit drafts.
- **Stripe's combined signature header** (`t=…,v1=…` in one header) is not supported yet. Senders that put the timestamp in its own header are.
- **Unverified webhooks** are allowed only with an explicit config acknowledgement. There is no separate validation warning.
- **IP in the trigger output:** `sourceIp` is included (it is `req.ip`, which honours `TRUST_PROXY`).
- **Provider name:** the generic trigger uses a dedicated table rather than `WorkflowTrigger`, which needs a provider and resource key.

**Verification**
- Unit: `src/modules/hooks/hook-config.spec.ts`, 17 tests covering config validation, every verification mode (token header/bearer, basic, HMAC sha256/sha1/sha512 in hex/base64 with prefixes, tampered body), timestamp replay window in both formats with forged timestamps, IP allow-list (IPv4, mapped, IPv6), constant-time compare, payload types, header picking and dedup ids. Full unit suite: 50 suites / 701 tests.
- Integration: `test/integration/hooks.int-spec.ts`, 21/21 on the real API, worker, Postgres and Redis. It covers:
  - provisioning with the secret shown once and only a hash stored;
  - 404 for unknown, archived and other-trigger workflows, with the URL surviving versions;
  - a fast 202 with the run executing asynchronously to SUCCEEDED and the full trigger output;
  - a generic 401 with a `REJECTED` row and no payload;
  - bearer, basic, HMAC over raw bytes (different bytes fail), Slack-style timestamped HMAC with an old request refused, IP allow-list, unverified mode;
  - secret rotation grace (old and new both valid, then grace 0), the sender's own secret, URL rotation grace;
  - form / text / XML payloads, 400 malformed JSON, 413 oversized;
  - header dedup with 5 concurrent deliveries giving 1 run (`duplicateCount` 4), and JSON-path dedup;
  - filter giving `IGNORED`; per-hook 429 with `Retry-After`;
  - custom 200 and 204 responses, challenge echo, 405, and an unrouted DELETE;
  - delivery log paging without secrets; replay to SUCCEEDED; rejected deliveries cannot be replayed;
  - one-shot test capture on a draft;
  - another workspace gets 404 on every admin route;
  - **Scenario 4**: webhook → `http.request` → condition → log, SUCCEEDED end to end.
- Full integration suite: 23 suites, 355 tests, green on the first run.
- Not covered by an automated test: the workspace daily cap (only the counter logic exists).

| AC | Status |
| --- | --- |
| AC-24.6 | Met (integration), except the optional 503 overload mode, which is not built (decision above) |
| AC-24.8 | Met (integration) |
| AC-24.7 | Met: Scenario 4 end to end. Slack is replaced by `util.log`, because Slack needs a connected workspace; the spec says Slack "or" Jira/Gmail later |
| AC-24.9 | See slice 3 below |

## Implementation Evidence: slice 3 (`http.poll`), 2026-10-04

**Delivered**
- `http.poll` trigger, defined alongside `http.request`:
  - `connectionId` (optional HTTP connection);
  - `request`: GET/POST, absolute or relative URL, query, headers, JSON body for POST, timeout. No templates, since there is no upstream data;
  - `schedule`: the Part 23 kinds, with the server minimum interval applying;
  - `items.path` (array) or the whole response as one item;
  - `identity.path` (id field) or a content hash;
  - `cursor` (`responsePath` → `queryParam`);
  - `seedOnFirstPoll` (default true) and `maxItemsPerPoll` (1–100, default 50).
- Scheduling reuses Part 23. `WorkflowSchedule.kind = POLL` (migration `20261004200000_http_poll`), so a poll occurrence gets the same claim (`SKIP LOCKED`, database clock) and misfire policy. It is not turned into a run: it is enqueued on the new `http-polls` queue (job id = occurrence). Polls are a separate queue so slow APIs never delay maintenance; worker concurrency is `HTTP_POLL_CONCURRENCY`.
- `HttpPollRunner` (worker), in this order:
  1. live check;
  2. state (`HttpPollState`), reset when the request/item settings change;
  3. backoff check;
  4. request through the egress guard, with connection auth, allowed hosts on every hop, and connection secrets scrubbed from the body;
  5. JSON only; items, identity and cursor are read from it;
  6. a transaction that locks the state row, re-checks the active version and inserts runs with ON CONFLICT DO NOTHING on `poll:<workflowId>:<itemId>` (`triggerSource = POLL`, trigger input `{ triggerType: 'POLL', item, itemId, polledAt, scheduleId }`), then updates the seen window (last 2 000 ids), cursor and counters;
  7. enqueue after commit; the sweeper covers enqueue failures.

  Failures are counted on the state and are never thrown. From the 3rd failure in a row the trigger is `FAILING`, with backoff of 1, 2, 4 … minutes, capped at 60.
- `GET /workspaces/:ws/workflows/:id/poll`: schedule (active, description, next run) and state (status, seeded, last poll / success / error, failures, next attempt, items fired). Seen ids and the cursor are not exposed, because they can be data from the polled API.
- Publish enforces `HTTP_POLL_MAX_PER_WORKSPACE` active polls (default 20; 422 `POLL_QUOTA_EXCEEDED`).
- Architecture tests updated:
  - `http.poll.request.url` is the second allowed URL setting, and the poll runner must send through `egress.send(`;
  - side-effect table (`http.poll`: none);
  - route inventory.

**Decisions and limits**
- **Exactly once:** "exactly one run per new item" rests on the unique run key, not on the seen window. Concurrent pollers, repeated jobs and a lost window cannot repeat an item that has fired, until retention deletes its run (default 90 days).
- **Seeded items:** items recorded only by seeding (never fired) rely on the window. If the window is lost they fire once. The integration test pins this.
- **Lost poll enqueue:** that occurrence is skipped; polling is state-based, so the next occurrence catches up. No sweeper is needed for polls.
- **Minimum interval:** the spec says a 1-minute minimum; the server's `SCHEDULE_MIN_INTERVAL_MINUTES` (default 5) applies, as for schedules.

**Verification**
- Unit: `src/modules/integrations/http/http-poll.spec.ts`, 10 tests covering config (URL guard, no templates, minimum interval, body, credential headers), item extraction, id/content identity, new items without repeats, the bounded window, cursor, config fingerprint and backoff. Full unit suite: 51 suites / 711 tests.
- Integration: `test/integration/polls.int-spec.ts`, 12/12 against a local test API:
  - publish creates the POLL schedule;
  - the first poll seeds without runs;
  - new items give one run each (to SUCCEEDED with the item in the step output), and repeats never fire, including after the seen window is wiped;
  - 3 concurrent pollers give exactly one run per item;
  - the cursor is sent from the previous response, and `maxItemsPerPoll` carries the rest to the next poll;
  - content-hash identity and firing on the first poll;
  - 3 failures give `FAILING` with backoff, then recovery;
  - a redirect to metadata is blocked;
  - non-JSON and missing ids are data errors;
  - a config change re-seeds;
  - archived workflows never poll;
  - the per-workspace quota gives 422;
  - **end to end**: schedule tick → poll queue → poll → run → SUCCEEDED.
- Also re-run after the evaluator change: `schedules.int-spec.ts` 15/15.
- Full integration suite: 24 suites, 368 tests, green.

| AC | Status |
| --- | --- |
| AC-24.9 | Met (integration with the local test API, including concurrent pollers and a lost seen window) |

## What remains before Part 24 is COMPLETE

- The CI run on the PR. Only local runs are recorded here.
- A live check of each direction against a real external API on the dev stack (an outbound call, an inbound webhook from a real sender, a poll).
- Known open items, recorded above:
  - the optional 503 overload mode for webhooks (not built);
  - Stripe's combined signature header;
  - an automated test of the workspace daily webhook cap;
  - the threat model was written during slice 1, not before it.

