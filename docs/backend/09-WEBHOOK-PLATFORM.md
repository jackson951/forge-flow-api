# 09 — Webhook Platform

**Status:** COMPLETE (2026-10-01) — evidence below; see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Provide generic, provider-agnostic webhook intake: identify the provider, verify authenticity, persist the delivery exactly once, normalise the event, match subscribed workflows, create runs idempotently and enqueue them — acknowledging quickly.

## Why This Part Exists

Webhooks are the main trigger source. Providers retry deliveries, send duplicates and occasionally replay old events; FlowForge must not start the same workflow twice for one event.

## Scope

Webhook controller and pipeline, `WebhookProvider` adapter contract (verify, extract delivery ID, normalise, resolve account), delivery persistence and deduplication, trigger matching, idempotent run creation, replay window, sanitised logging, a test provider adapter.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-09.1 | `POST /api/v1/webhooks/:provider` accepts deliveries for registered providers; unknown provider → 404. |
| FR-09.2 | Signature verified over the raw request body before any parsing side effects; failure → 401, nothing persisted except a rate-limited log line. |
| FR-09.3 | Delivery ID extracted from provider headers; missing → 400. |
| FR-09.4 | Delivery stored in `WebhookDelivery` with unique (`provider`, `deliveryId`); a duplicate returns `200 { duplicate: true }` and creates no runs. |
| FR-09.5 | Event normalised to `{ provider, eventType, externalAccountId, resourceKey, occurredAt, data }`. |
| FR-09.6 | Matching `WorkflowTrigger`s found by (`provider`, `eventType`, `resourceKey`) and connection → one run per matching workflow with `idempotencyKey = "${provider}:${deliveryId}:${workflowId}"`. |
| FR-09.7 | Delivery row, run rows and status update are committed in one transaction; enqueue happens after commit (sweeper covers enqueue failures). |
| FR-09.8 | Response `202` within the target latency (p95 < 200 ms locally), with no outbound provider calls in the request path. |
| FR-09.9 | Deliveries whose provider timestamp (if supplied) is older than the replay window (5 min, e.g. Slack) are rejected. |

## Technical Requirements

- Raw body: Nest `rawBody: true` (already enabled); body limit for webhook route 1 MB.
- Adapter contract:

  ```ts
  interface WebhookProvider {
    key: IntegrationProvider;
    verify(req: RawWebhookRequest): VerificationResult;      // constant-time compare
    deliveryId(req): string;
    normalize(req): NormalizedEvent | null;                   // null = ignored event type
  }
  ```

- Dedup: `INSERT … ON CONFLICT DO NOTHING RETURNING id` semantics (Prisma `createMany({ skipDuplicates })` + lookup, or catch `P2002`). The database constraint, not a prior `SELECT`, is the guard.
- Delivery status: `RECEIVED` → `PROCESSED` (runs created) / `IGNORED` (no matching triggers or ignored event) / `FAILED`.
- Stored payload is the normalised, size-limited event; the raw body is not stored.
- Logs include provider, deliveryId, eventType, matched workflow count, duration; never headers containing signatures or payload bodies.
- Webhook routes throttled separately from user routes (Part 18).

## API Changes

| Method | Path | Auth | Responses |
| --- | --- | --- | --- |
| POST | `/api/v1/webhooks/:provider` (slug, e.g. `github`, `test`) | Provider signature | `202 { accepted, duplicate: false, deliveryId, runs }`, `200 { accepted, duplicate: true, deliveryId }`, `400` missing delivery id, `401` bad signature / replay window, `404` unknown or disabled provider, `413` body > 1 MB or event data > 256 KB |

## Database Changes

Uses `WebhookDelivery`, `WorkflowTrigger`, `WorkflowRun.idempotencyKey`, `WorkflowRun.webhookDeliveryId` (Part 02).

## Security Requirements

- `crypto.timingSafeEqual` for signature comparison; length check first.
- Secrets per provider from config/credential store; never logged.
- Invalid-signature requests produce no DB writes (prevents storage abuse).
- Payload stored without secrets; body size capped.

## Testing Requirements

- Unit: test adapter verify/normalise; idempotency-key construction; replay window.
- Integration: valid → 202 + delivery + run + job; invalid signature → 401 and zero rows; same delivery twice sequentially → one run; same delivery 10× concurrently → exactly one delivery row and one run per workflow; one delivery matching two workflows → two runs; no matching trigger → `IGNORED`; oversize → 413; handler does not call providers (outbound HTTP mocked to fail the test if called).

## Deliverables

Webhooks module (controller, pipeline service, provider registry), `TestWebhookProvider` (enabled in non-production) for end-to-end testing without GitHub, tests.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-09.1 | Valid webhook accepted (202) and run enqueued | Integration |
| AC-09.2 | Invalid signature rejected (401), nothing persisted | Integration |
| AC-09.3 | Duplicate delivery detected (200 duplicate) | Integration |
| AC-09.4 | Duplicate (incl. concurrent) doesn't create duplicate runs | Integration with parallel requests |
| AC-09.5 | Handler responds quickly with no outbound calls | Integration timing + outbound-call guard |
| AC-09.6 | Processing happens in worker | Integration: run executed by worker harness |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Outgoing webhooks, generic "catch any webhook" user endpoints with per-workflow secrets (possible later), payload transformation UI.

## Dependencies

Parts 06, 07, 08.

## Risks / Design Questions

- **Delivery ID uniqueness** differs by provider: GitHub's `X-GitHub-Delivery` is unique per delivery attempt but **redeliveries of the same event reuse it**, which is exactly the desired dedup key. Slack uses `event_id`. Documented per adapter.
- **Retention:** deliveries kept 30 days (cleanup job in Part 21); runs keep a nullable reference.

## Implementation Notes

Replaces the scaffold `WebhooksService` stub. The scaffold's `ParseEnumPipe` on `:provider` becomes a registry lookup.

## Implementation Evidence

Verified 2026-10-01 on branch `feat/part-11-09-conditions-and-webhooks`.

### What was implemented

| Item | Location |
| --- | --- |
| Adapter contract (`verify`, `deliveryId`, `eventName`, `normalize`), constant-time HMAC helper | `src/modules/webhooks/providers/webhook-provider.ts` |
| Non-production `test` provider: HMAC-SHA256 over `<timestamp>.<raw body>`, 5-minute replay window; enabled only when `NODE_ENV != production` and `WEBHOOK_TEST_SECRET` is set | `providers/test-webhook.provider.ts` |
| Intake pipeline: verify (no writes on failure) → delivery id → normalise → one transaction (unique delivery insert, trigger match on the active version, one run per workflow with `<provider>:<deliveryId>:<workflowId>`, delivery status/workspace) → enqueue after commit (sweeper fallback) | `webhook-intake.service.ts` |
| Raw-body parser for `/api/v1/webhooks` with a 1 MB limit, registered before the general 300 KB parser | `src/app.setup.ts` |
| `TEST` value in `IntegrationProviderKey` (migration `20261001150000_test_webhook_provider`) | `prisma/` |
| Throttle 600/min per IP on webhook routes; sanitised logs (provider, delivery id, event, run count, duration; never headers or bodies) | controller / service |

### Command results

| Command | Result |
| --- | --- |
| prettier check, lint, typecheck, build | pass |
| `npm test` | 328 passed |
| `npm run test:e2e` | 16 passed |
| `npm run test:int` | 175 passed (14 in `webhooks.int-spec.ts`) |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-09.1 | PASS | Signed delivery → 202 with `runs: 1`; delivery PROCESSED with workspace; run has `triggerSource WEBHOOK`, delivery link, normalised data as trigger input, idempotency key |
| AC-09.2 | PASS | Wrong secret, tampered body, stale timestamp → 401 and the delivery count is unchanged; missing delivery id → 400; unknown provider → 404. Unit: future timestamp, missing signature/timestamp, truncated or wrong-algorithm signatures |
| AC-09.3 | PASS | Second send of the same delivery → 200 `duplicate: true`; a re-signed redelivery with the same id is also a duplicate |
| AC-09.4 | PASS | 10 concurrent copies → exactly one 202, nine 200, one delivery row, one run |
| AC-09.5 | PASS | Request completes in well under 1 s locally and `fetch` is never called during intake |
| AC-09.6 | PASS | The worker executes the webhook-created run; a template in the next step renders the webhook data (`got Crash on login`) |

Also verified: one delivery starts every matching published workflow once; deliveries with no matching trigger or an unusable payload are stored as IGNORED with no runs; archived workflows no longer trigger; bodies between 300 KB and 1 MB are accepted on webhook routes only; body > 1 MB and event data > 256 KB → 413.

### Notes

- Event matching uses the routing table maintained at publish (Part 06) and re-checks that each routing row belongs to the workflow's active version.
- The `test` provider can match workflows in any workspace that uses the same resource key; it exists for development and tests only and is never enabled in production. Real providers bind events to a connected account (Part 10).
- Delivery retention (30 days) is a Part 21 maintenance job.
