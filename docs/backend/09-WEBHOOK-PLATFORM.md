# 09 — Webhook Platform

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

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
| POST | `/api/v1/webhooks/:provider` | Provider signature | `202 { accepted: true, runs: n }`, `200 { duplicate: true }`, `400`, `401`, `404`, `413` |

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
