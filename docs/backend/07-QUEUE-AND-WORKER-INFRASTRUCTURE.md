# 07 — Queue and Worker Infrastructure

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

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
| POST | `/api/v1/workspaces/:workspaceId/workflows/:workflowId/runs` | MEMBER | `202 { runId, status: "QUEUED" }`; `409` if workflow has no active version or trigger isn't manual |

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
