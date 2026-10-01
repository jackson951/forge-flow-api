# 15 — Idempotency and Side-Effect Safety

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

## Objective

Define, implement and test FlowForge's delivery guarantees end to end, and state honestly what cannot be guaranteed.

## Why This Part Exists

Distributed components (provider → API → DB → Redis → worker → provider) fail independently. Without an explicit strategy, retries either lose work or duplicate side effects. FlowForge does **not** provide exactly-once execution; it provides **at-least-once processing with deduplication at every boundary where a key exists**, and **at-most-once-after-uncertainty** for non-idempotent side effects.

## Scope

Review and harden Parts 07–14 against the scenarios below; add missing mechanisms; write automated duplicate/retry tests; document guarantees.

## Functional Requirements

### Guarantees by boundary

| Boundary | Mechanism | Guarantee |
| --- | --- | --- |
| Provider → API | unique (`provider`, `deliveryId`) | One delivery row per provider delivery |
| Delivery → runs | unique (`workspaceId`, `idempotencyKey`) | One run per (delivery, workflow) |
| Run → queue | `jobId = runId`; sweeper for lost enqueues | At least one job per run; duplicates collapse |
| Job → steps | conditional status updates; succeeded steps skipped | Succeeded step never re-executed by the engine |
| Step → provider (idempotent / supports key) | provider idempotency key = `${runId}:${nodeKey}` | Duplicate calls safe |
| Step → provider (non-idempotent) | `RUNNING` marker before call; uncertain → no automatic retry | At most one automatic call after an uncertain outcome; possible duplicate only via explicit manual retry |

### Scenarios

| # | Scenario | Behaviour |
| --- | --- | --- |
| S1 | GitHub sends the same webhook twice | Second insert conflicts → `200 duplicate`, no new run (Part 09). |
| S2 | Worker receives the same job twice (stalled job redelivery / duplicate enqueue) | `jobId` collapses duplicates; if two workers race, the `QUEUED→RUNNING` conditional update lets only one claim the run; the other exits. Succeeded steps are skipped on resume. |
| S3 | Slack message sent, worker crashes before marking step `SUCCEEDED` | On redelivery the step is found `RUNNING`, handler is `non-idempotent` → step `FAILED` with `UNCERTAIN_OUTCOME`, run `FAILED`, no automatic resend. Run detail shows "outcome unknown — check Slack before retrying". |
| S4 | Provider times out after possibly processing | Timeout is treated as uncertain for non-idempotent handlers (no automatic retry, `UNCERTAIN_OUTCOME`); idempotent handlers retry. Connection errors before the request was sent (DNS, connect refused) are safe to retry. |
| S5 | Worker restarts mid-execution | Graceful: active job finishes within shutdown timeout. Hard kill: job stalls → redelivered → resume per S2/S3. |
| S6 | User manually retries a failed run | Creates a new run (`triggerSource=RETRY`, `retryOfRunId`) on the **same version** with the same trigger input, new idempotency keys. Allowed only for `FAILED` runs; UI/API warns when the failed step was `UNCERTAIN_OUTCOME`. Optional `resumeFromFailedStep` copies succeeded step outputs so completed side effects are not repeated. |
| S7 | Redis reconnects | ioredis reconnects automatically; enqueue failures during the outage leave runs `QUEUED` → sweeper re-enqueues. Webhook requests during an outage still succeed (DB commit) and are recovered by the sweeper. Readiness reports Redis down. |
| S8 | Database temporarily unavailable | API returns `503` (webhook providers retry). Worker: Prisma errors classified `TRANSIENT_INFRASTRUCTURE` → job retried with backoff; no provider call is made before its `RUNNING` marker is persisted. |

## Technical Requirements

- `sideEffect` declared on every handler (Part 08) and reviewed here; table of handlers and classification maintained below.
- Provider idempotency keys used where supported (e.g. HTTP `Idempotency-Key` for providers that document it). Currently used integrations: GitHub (comment action — no key; non-idempotent), Slack (no key), Graph To Do (no key), AI (no external state; idempotent).
- Error classification distinguishes "request not sent" from "response not received".
- Run claim: `UPDATE WorkflowRun SET status='RUNNING', lockedBy=?, attemptCount=attemptCount+1 WHERE id=? AND status IN ('QUEUED')` — zero rows → exit.
- Retry API validates state transitions and is ADMIN-only.

## API Changes

| Method | Path | Min role |
| --- | --- | --- |
| POST | `/api/v1/workspaces/:workspaceId/runs/:runId/retry` | ADMIN, body `{ resumeFromFailedStep?: boolean }` → `202 { runId }` |

(Owned jointly with Part 16.)

## Database Changes

`WorkflowRun.retryOfRunId`, `triggerSource`, `lockedBy`; `ErrorCategory` gains `UNCERTAIN_OUTCOME`.

## Security Requirements

Retries re-use stored (sanitised) trigger input; retry cannot change the version or inject new input.

## Testing Requirements

Automated tests, one per scenario:

- S1 duplicate webhook (sequential and concurrent).
- S2 same job processed twice concurrently → one execution of each handler (call-count assertion).
- S3 simulate crash after handler success before persistence (fault-injection hook in `RunStore`) → redelivery yields `UNCERTAIN_OUTCOME`, handler called once.
- S4 timeout on non-idempotent handler → no automatic retry; on idempotent → retried.
- S5 stalled job redelivery via short lock duration in test.
- S6 manual retry creates new run on same version; `resumeFromFailedStep` skips completed steps.
- S7 enqueue failure (queue mocked to throw) → run QUEUED → sweeper enqueues.
- S8 Prisma transient error in worker → job retried; handler not invoked before marker persisted.

## Deliverables

Hardening changes across engine/queue/webhooks, fault-injection hooks (test-only), scenario test suite `test/integration/reliability.int-spec.ts`, this document as the guarantees reference.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-15.1–15.8 | Scenario S1–S8 behave as specified | One automated test per scenario |
| AC-15.9 | Every registered handler declares `sideEffect`, reviewed in the table | Startup check + doc table |
| AC-15.10 | Documentation states at-least-once semantics and no exactly-once claim | Review |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Distributed transactions, sagas/compensation, provider-side dedup via message search.

## Dependencies

Parts 07–14.

## Risks / Design Questions

- **Choosing failure over duplication for uncertain non-idempotent calls** trades availability for correctness; right choice for notifications and task creation. Configurable per node in future ("at-least-once allowed").
- Slack dedup via searching recent messages was considered and rejected (needs extra scopes, racy).

## Implementation Notes

Already in place after Parts 07–08 (to be re-verified here): `jobId = runId`; claim via conditional update; succeeded steps never re-executed; RUNNING non-idempotent step → UNCERTAIN_OUTCOME; non-idempotent timeouts → UNCERTAIN_OUTCOME; sweeper for lost enqueues; manual-run `Idempotency-Key`.


Handler classification table (fill in as handlers ship):

| Handler | sideEffect | Provider idempotency key |
| --- | --- | --- |
| manual.trigger, condition, util.log | none | n/a (implemented in Part 08) |
| ai.* | idempotent | n/a |
| slack.sendMessage | non-idempotent | none available |
| microsoft.todo.createTask | non-idempotent | none available |
