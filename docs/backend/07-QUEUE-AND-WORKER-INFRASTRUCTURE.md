# 07 — Queue and Worker Infrastructure

**Status:** COMPLETE (2026-10-01) — evidence below; see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Introduce a durable, observable asynchronous boundary between the API (accepts and records work) and the worker (performs it) using BullMQ on Redis.

## Why This Part Exists

Workflow runs call slow and unreliable external APIs. Running them in HTTP handlers would tie request latency and availability to third parties and lose work on crashes. A queue gives retries, backoff, concurrency control and independent scaling.

## Scope

Queue configuration, job contracts, producer service, worker entrypoint, processor base with logging, retry/backoff policy, permanent-failure handling, stuck-run recovery, graceful worker shutdown, a manual-trigger endpoint to exercise the pipeline.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-07.1 | The API creates a `WorkflowRun` (`QUEUED`) in the database, then enqueues `execute-run { runId }` with `jobId = runId`, and returns `202` without executing anything. |
| FR-07.2 | The worker process consumes `workflow-runs` jobs and invokes the execution service. |
| FR-07.3 | Transient failures are retried with exponential backoff (default 5 attempts, base 2 s, jitter) and recorded on the run. |
| FR-07.4 | Permanent failures are not retried (BullMQ `UnrecoverableError`) and mark the run `FAILED`. |
| FR-07.5 | After the final failed attempt the run is marked `FAILED` with the last error category. |
| FR-07.6 | A recovery sweeper re-enqueues runs stuck in `QUEUED` longer than 60 s (covers "DB commit succeeded, enqueue failed"). |
| FR-07.7 | `POST .../workflows/:workflowId/runs` (manual trigger with JSON input) exercises the pipeline for workflows whose trigger is `manual.trigger`. |

## Technical Requirements

- Queues: `workflow-runs` (execution), `maintenance` (repeatable sweeper). Names and job payload types in `src/queue/contracts.ts`; payloads contain IDs only, never workflow data or secrets.
- Job options: `jobId = runId` (enqueue is idempotent), `attempts`, `backoff: exponential`, `removeOnComplete: { age: 24h, count: 1000 }`, `removeOnFail: { age: 7d }`.
- Worker concurrency from `WORKER_CONCURRENCY` (default 5); lock duration sized above the longest step timeout; `maxStalledCount: 1`.
- Separate Redis connection for the worker with `maxRetriesPerRequest: null` (BullMQ requirement).
- Processors are only registered in `WorkerModule`; `AppModule` imports the queue for producing only. A test asserts the API module has no processor providers.
- Error classification: the engine throws `RetryableError` / `PermanentError` (with `ErrorCategory`); the processor maps permanent errors to `UnrecoverableError`.
- Structured logging: every log line from a job includes `jobId`, `runId`, `attempt`, `correlationId` (propagated from the API request that created the run, stored on the run).
- Graceful shutdown: on SIGTERM the worker stops fetching new jobs, waits for active jobs up to `WORKER_SHUTDOWN_TIMEOUT_MS` (default 30 s), then closes. Jobs not finished become stalled and are re-delivered to another worker.
- Failed-job handling: `failed` event listener logs category and updates run state; failed jobs retained for inspection.

## API Changes

| Method | Path | Min role | Response |
| --- | --- | --- | --- |
| POST | `/api/v1/workspaces/:workspaceId/workflows/:workflowId/runs` | MEMBER | body `{ input? }` (≤ 64 KB), optional `Idempotency-Key` header → `202 { runId, status }`; same key → same run; `409` if unpublished, archived, or trigger isn't manual |

## Database Changes

`WorkflowRun` fields used: `status`, `correlationId`, `attemptCount`, `lastErrorCategory`, `queuedAt`.

## Security Requirements

- Job payloads carry IDs only; the worker re-loads and re-scopes data by `workspaceId`.
- Redis password supported via configuration; Redis never exposed publicly in Compose beyond localhost.
- Manual trigger input is size-limited (64 KB) and stored sanitised.

## Testing Requirements

- Unit: retry classification mapping, backoff options, sweeper selection query.
- Integration (real Redis): API enqueue → job exists with `jobId = runId`; duplicate enqueue for same run creates no second job; worker test harness processes a job; a handler throwing `RetryableError` is retried with backoff (fast backoff in tests) and eventually succeeds; `PermanentError` → single attempt, run `FAILED`; sweeper re-enqueues a stale `QUEUED` run.
- Assertion that the HTTP response returns before execution (execution handler blocked on a latch while the request completes).

## Deliverables

`src/queue/` module and contracts, `RunDispatcherService` (API side), `WorkflowRunProcessor` (worker side), sweeper, worker bootstrap with shutdown, tests.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-07.1 | API enqueues job and returns 202 | Integration |
| AC-07.2 | Worker receives and processes the job | Integration |
| AC-07.3 | Run state transitions QUEUED → RUNNING → SUCCEEDED persisted | Integration |
| AC-07.4 | Transient failure retried per configuration | Integration counting attempts |
| AC-07.5 | Permanent failure attempted once, run FAILED | Integration |
| AC-07.6 | API never executes workflows synchronously | Latch test + module test (no processors in AppModule) |
| AC-07.7 | Worker shuts down gracefully (active job completes or is re-delivered) | Integration using `worker.close()` + manual container stop |
| AC-07.8 | Stuck QUEUED run recovered | Integration |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Scheduling/cron triggers, priority queues, per-tenant fairness (noted in Part 21), BullMQ dashboard UI.

## Dependencies

Parts 01, 02, 06.

## Risks / Design Questions

- **Dual write (DB then Redis)** can leave a run un-enqueued; the sweeper fixes this. A transactional outbox would be stricter but is unnecessary at this scale.
- **Stalled jobs** mean a step can run twice — handled by Part 15's side-effect policy.

## Implementation Notes

The scaffold already registers a `workflow-runs` queue and a stub processor; this part replaces the stub and moves queue code from `src/infrastructure/queue` to the agreed module.

## Implementation Evidence

Verified 2026-10-01 on branch `feat/part-07-08-queue-and-engine` (from `main` at `4dee5c6`), together with Part 08.

### What was implemented

| Item | Location |
| --- | --- |
| Queue config (prefix, attempts, exponential backoff with jitter, retention), queues `workflow-runs` + `maintenance`, job contracts (ids only) | `src/infrastructure/queue/*`, `src/config/env.schema.ts` |
| `RunQueue.enqueue` with `jobId = runId` | `src/infrastructure/queue/run-queue.service.ts` |
| API dispatcher: QUEUED run bound to the active version, correlation id, `Idempotency-Key`, DB-then-Redis with sweeper fallback | `src/modules/runs/run-dispatcher.service.ts`, `workflow-runs.controller.ts` |
| Worker: `ExecutionModule` (worker-only), `WorkflowRunProcessor` (configurable concurrency, `maxStalledCount: 1`), `RunWorkerService` (claim, run, retry/permanent mapping via `UnrecoverableError`) | `src/execution/*`, `src/worker.module.ts` |
| Error classification: `RetryableError` / `PermanentError` with `ErrorCategory`; transient DB errors retryable; unknown errors INTERNAL and not retried | `src/engine/errors.ts` |
| Sweeper on a BullMQ job scheduler (`upsertJobScheduler`, one schedule shared by all workers) | `src/execution/processors.ts` |
| Worker refuses to start if any catalog node type lacks a matching handler | `ExecutionModule.onModuleInit` |
| Test isolation: unique `QUEUE_PREFIX` per test file, fast backoff, Redis key teardown | `test/setup-*.ts`, `test/global-teardown.ts` |

### Command results

| Command | Result |
| --- | --- |
| prettier check, lint, typecheck, build | pass |
| `npm test` | 224 passed |
| `npm run test:e2e` | 16 passed |
| `npm run test:int` | 158 passed (15 in `execution.int-spec.ts`) |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-07.1 | PASS | Integration: 202 `{ runId, status: QUEUED }`; run row with `triggerSource MANUAL`, input and correlation id; job exists with id = run id and payload `{ runId }`. Live: 202 in 31 ms |
| AC-07.2 | PASS | Integration: in-process WorkerModule picks up the job (including runs queued before it started). Live: separate `node dist/worker.js` process executed a run created via HTTP on a separate `node dist/main.js` |
| AC-07.3 | PASS | Run QUEUED → RUNNING → SUCCEEDED with `startedAt`/`completedAt`; mid-run state observed as RUNNING (latch test) |
| AC-07.4 | PASS | `test.flaky` fails twice (retryable) → three job attempts with backoff → run SUCCEEDED, `attemptCount 3`, step `attemptCount 3` |
| AC-07.5 | PASS | Permanent failure: job `attemptsMade 1`, state `failed`, run FAILED with category and message. Retryable failure exhausts all 3 attempts → FAILED |
| AC-07.6 | PASS | `WorkflowRunProcessor` is not resolvable in the API app; a queued run stays QUEUED with no steps while no worker runs |
| AC-07.7 | PASS | `worker.close()` waits for the active job (still open after 300 ms while the step is held) and returns only after the run SUCCEEDED |
| AC-07.8 | PASS | A QUEUED run with no job (simulated lost enqueue) is re-enqueued by `RunSweeper.sweep()` and completes |

Also verified: `Idempotency-Key` replay returns the same run with one row; reusing a key for another workflow → 409; malformed key → 400; unpublished / archived / webhook-triggered workflows → 409; manual input > 64 KB → 400. **Live log correlation:** the API's request id for "Run queued" appeared as `correlationId` on the worker's "Run started"/"Run finished" lines with `runId`, `jobId`, `attempt`, `workflowVersionId`; no secrets in either log.

### Notes / limitations

- Provider `Retry-After` values are carried on `RetryableError.retryAfterMs` but not yet used to schedule the retry (plain exponential backoff); Part 13 (Slack rate limits) wires that in.
- Worker graceful shutdown is proven in-process (`close()` drains the active job). Stopping the worker *container* with SIGTERM is verified in Part 20 together with the Compose worker service.
- `removeOnComplete`/`removeOnFail` keep 24 h / 7 d of job history in Redis; run history lives in Postgres.
