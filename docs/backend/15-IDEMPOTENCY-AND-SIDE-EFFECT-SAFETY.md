# 15 — Idempotency and Side-Effect Safety

**Status:** COMPLETE (2026-10-02) — evidence below; see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

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

| Handler | sideEffect | Provider idempotency key | On a step found RUNNING after a crash |
| --- | --- | --- | --- |
| manual.trigger, schedule.trigger, webhook.received, http.poll, condition, util.log | none | n/a | re-executed |
| github.issue.created (trigger) | none | n/a | re-executed |
| ai.summarize, ai.classify, ai.extract | idempotent | n/a (no external state; costs tokens) | re-executed |
| slack.sendMessage | non-idempotent | none available (`chat.postMessage`) | UNCERTAIN_OUTCOME |
| microsoft.todo.createTask | non-idempotent | none available (Graph To Do) | UNCERTAIN_OUTCOME |
| jira.createIssue, jira.updateIssue, jira.addComment, jira.transitionIssue, jira.assignIssue (Part 25) | non-idempotent | none available (Jira REST v3) | UNCERTAIN_OUTCOME |
| jira.getIssue, jira.searchIssues (Part 25) | idempotent | n/a (reads) | re-executed |
| jira.issue.created / updated / transitioned (triggers) | none | n/a | re-executed |
| http.request (Part 24) | non-idempotent | `Idempotency-Key: <runId>:<nodeKey>` sent when a POST/PATCH is marked `idempotent` | UNCERTAIN_OUTCOME (attempt retries follow the method: GET/HEAD/PUT/DELETE and `idempotent` POST/PATCH retry transient failures) |

Enforced by `src/engine/execution/side-effects.spec.ts` (the table must match the code) and by the worker's startup check (a handler without a valid `sideEffect` stops the worker).

## Delivery guarantees (reference)

**FlowForge does not provide exactly-once execution.** It provides:

- **at-least-once processing** of every accepted trigger (a committed run is eventually executed, even if Redis or a worker fails in between);
- **deduplication at every boundary that has a key** (provider delivery id, run idempotency key, job id = run id, step state);
- **at-most-once-after-uncertainty** for non-idempotent side effects: once FlowForge cannot know whether a Slack message was posted or a To Do task created, it stops and reports `UNCERTAIN_OUTCOME` instead of trying again. A side effect can be repeated only through an explicit manual retry that acknowledges the uncertainty.

What is still possible, by design: a provider action happens but FlowForge records the step as `UNCERTAIN_OUTCOME` (it cannot know), and a human-approved retry repeats it.

### How the guarantees are implemented

| Mechanism | Where |
| --- | --- |
| Unique (provider, deliveryId); unique (workspaceId, idempotencyKey) | Part 09 schema + intake |
| `jobId = runId`; sweeper re-enqueues QUEUED runs whose enqueue was lost | Part 07 |
| **Run claim with fencing token**: `lockedBy = <worker>:<uuid>` per claim. QUEUED → RUNNING normally; RUNNING → RUNNING when a stalled job is redelivered. The newest claim owns the run; `startStep`, `failStep`, `skipRemaining` and run outcome writes require `lockedBy = claim` and otherwise throw `OwnershipLostError` — the superseded worker stops without writing | `PrismaRunStore`, `RunWorkerService`, `ExecutionEngine` |
| RUNNING marker persisted (fenced) **before** a handler runs | `ExecutionEngine.runNode` |
| Step found RUNNING on resume: idempotent → re-executed; non-idempotent → `UNCERTAIN_OUTCOME` | `ExecutionEngine` (Part 08) |
| Overlap after redelivery: if a step write is refused because the other worker already recorded the step SUCCEEDED, its stored result is used | `ExecutionEngine.recordedSuccess` |
| `completeStep` is not fenced: a worker that did the work records the truth even after losing the run | `RunStore` contract |
| "Request not sent" (DNS, refused, unreachable, TLS) → retryable; timeout or connection lost mid-request → `UNCERTAIN_OUTCOME` for side effects, retryable for reads | `src/common/http/fetch-failure.ts`, Slack and Graph clients |
| Non-idempotent step timeout → `UNCERTAIN_OUTCOME` | `ExecutionEngine.invoke` (Part 08) |
| Provider `Retry-After` honoured by the queue | Part 13 backoff |
| Job lock duration configurable (`WORKER_LOCK_DURATION_MS`, default 30 s): a crashed worker's job is redelivered after about that long | `src/execution/processors.ts`, `env.schema.ts` |
| Manual retry: FAILED runs only, ADMIN only, same version and stored input, new keys, `Idempotency-Key` supported; **refused with 409 `UNCERTAIN_OUTCOME` unless `acknowledgeUncertainOutcome: true`**; `resumeFromFailedStep` copies SUCCEEDED steps (with their stored, sanitised outputs) so completed side effects are not repeated; audited as `run.retried` | `RunDispatcherService.retryRun`, `POST /api/v1/workspaces/:workspaceId/runs/:runId/retry` |

### Decisions that differ from the original text

- **Run claim from RUNNING is allowed** (the spec sketched `WHERE status IN ('QUEUED')`). Without it, a run whose worker crashed would stay RUNNING forever after its job is redelivered. Safety comes from the fencing token instead: only the newest claim can start steps or decide the outcome.
- **"UI/API warns" on uncertain retries is implemented as a required acknowledgement** (409 until `acknowledgeUncertainOutcome: true`), so a duplicate can only follow a deliberate decision.
- `resumeFromFailedStep` reuses **sanitised** outputs (credential-like values redacted at storage time, Part 17); a later step that needed such a value would see `[REDACTED]`. Retrying without resume re-executes everything.

## Implementation Evidence

Verified 2026-10-02 on branch `feat/part-15-idempotency` (from `main` at `c59d4d0`).

### Command results

| Command | Result |
| --- | --- |
| prettier check, lint (0 warnings), typecheck, build | pass |
| `npm test` | 526 passed (engine fencing and overlap tests in `execution-engine.spec.ts`, `side-effects.spec.ts`, `fetch-failure.spec.ts`) |
| `npm run test:e2e` | 16 passed |
| `npm run test:int` | 256 passed (13 in `test/integration/reliability.int-spec.ts`; the suite passed 3 consecutive runs) |

### Acceptance criteria

| ID | Scenario | Result | Evidence (`reliability.int-spec.ts` unless noted) |
| --- | --- | --- | --- |
| AC-15.1 | S1 duplicate webhook | PASS | Same delivery twice → 202 then 200 `duplicate: true`; 10 concurrent copies → one 202; one run each; side effect once per run |
| AC-15.2 | S2 same job twice | PASS | Five runs, each processed by three workers at once: every side effect executed at most once (first step exactly once); runs end SUCCEEDED, or FAILED with `UNCERTAIN_OUTCOME` when an overlap made the outcome unknown — never a duplicate |
| AC-15.3 | S3 crash after side effect, before recording | PASS | Worker hard-killed (BullMQ worker force-closed, lock not renewed) while the handler is past its provider call → job redelivered to a new worker → step FAILED `UNCERTAIN_OUTCOME` with the redelivery message, run FAILED, side effect recorded once; the killed worker's handler then returns and changes nothing (fenced) |
| AC-15.4 | S4 timeouts | PASS | Non-idempotent step timeout → `UNCERTAIN_OUTCOME`, attempt 1, no retry; idempotent step timeout → retried, SUCCEEDED on attempt 2. Unit: refused/DNS → retryable; reset/timeout → uncertain for side effects (`fetch-failure.spec.ts`, `slack.spec.ts`) |
| AC-15.5 | S5 worker restart | PASS | Hard kill mid idempotent step → redelivered, step re-executed, run SUCCEEDED, following side effect once. Graceful shutdown: existing AC-07.7 test |
| AC-15.6 | S6 manual retry | PASS | MEMBER 403, non-FAILED 409, unknown 404; new run on the failed run's version (a newer version had been published) with the same input, `RETRY` + `retryOfRunId`, new idempotency key; `resumeFromFailedStep` → succeeded steps reused, side effect not repeated, audited; same `Idempotency-Key` → same run; uncertain run → 409 `{ code: 'UNCERTAIN_OUTCOME', nodeKeys }` until acknowledged |
| AC-15.7 | S7 Redis/enqueue failure | PASS | Enqueue throws → API still 202, run stays QUEUED → sweeper re-enqueues → SUCCEEDED, side effect once (readiness reporting Redis down: Part 01 tests) |
| AC-15.8 | S8 database transient error | PASS | `P1001` on the step's RUNNING marker → job retried (run attempt 2), step attempt 1 (first marker never persisted), provider called once |
| AC-15.9 | Every handler declares sideEffect | PASS | Table above = code (`side-effects.spec.ts`); worker refuses to start on a missing/invalid `sideEffect` (unit) |
| AC-15.10 | No exactly-once claim | PASS | "Delivery guarantees" section above |

**Mutation checks** (each made tests fail, then reverted): removing the step fencing (S2 produced duplicate side effects); re-executing a non-idempotent step found RUNNING (S3); removing the retry acknowledgement (S6); removing the overlap tolerance (engine unit tests).

### Found and fixed during this part

- **Duplicate side effects when two workers process the same run** (stalled redelivery while the original worker is alive, or a duplicate job): both could move the step PENDING → RUNNING and call the provider. Fixed with per-claim fencing tokens.
- **False failures after redelivery:** when the original and the redelivered worker both finished an idempotent step, the second write was an "illegal transition" and the run failed as INTERNAL (seen at both `completeStep` and `startStep`). Now the recorded success is reused.
- **Network errors were not split into "not sent" and "maybe sent":** any non-timeout failure of `chat.postMessage` or a task creation was retried, which could duplicate a message after a connection reset. Now only failures before sending are retried.
- **S3 test initially passed for the wrong reason:** the killed worker's own step timeout (1.5 s) produced `UNCERTAIN_OUTCOME` before the redelivery rule ran. The suite now uses a 5 s step timeout and asserts the redelivery rule's message; the mutation check then failed as expected.
