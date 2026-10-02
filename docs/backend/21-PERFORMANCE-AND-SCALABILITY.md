# 21 — Performance and Scalability

**Status:** COMPLETE WITH EXCEPTIONS (2026-10-02) — AC-21.3 passes for intake alone but not with workers on the same local disk; AC-21.1 at load scale lacks the duplicate-check query; FR-21.9 and FR-21.12-under-load not measured. Accepted for now (frontend next). See [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Review the architecture for realistic growth, measure actual bottlenecks with a simple load test, fix the ones that matter, and record decisions — without premature optimisation.

## Why This Part Exists

The design choices (stateless API, queue workers, JSON snapshots, tree graphs) are meant to scale horizontally; this part verifies that claim with numbers and closes gaps (retention, pool sizing, backpressure).

## Scope

Review checklist below, load test for webhook intake and run execution, query plan review of hot queries, retention jobs, configuration for concurrency/pools, decision log.

## Functional Requirements

| ID | Area | Requirement / decision to verify |
| --- | --- | --- |
| FR-21.1 | Stateless API | No in-memory session/rate-limit/OAuth state; two API instances behind a proxy behave identically. |
| FR-21.2 | Horizontal workers | Multiple workers consume safely (run claim, jobId dedup). |
| FR-21.3 | Queue/worker concurrency | `WORKER_CONCURRENCY` tuned; per-provider concurrency limits (BullMQ group/rate limiter or semaphore) so one provider's rate limit doesn't stall all runs. |
| FR-21.4 | DB pooling | Prisma `connection_limit` per process sized so `(api instances × pool) + (workers × pool) < Postgres max_connections` with headroom; documented formula. |
| FR-21.5 | Indexes | `EXPLAIN ANALYZE` of run list, webhook trigger match, membership check, step list at 1M runs → index scans. |
| FR-21.6 | Pagination | Keyset pagination everywhere; no `OFFSET`. |
| FR-21.7 | N+1 | Run list doesn't load steps; workflow list doesn't load definitions; verified via Prisma query log count. |
| FR-21.8 | Large histories | Retention: webhook deliveries 30 d, step I/O payloads trimmed after 30 d, runs kept 90 d (configurable) via maintenance job in batches. |
| FR-21.9 | Workflow size | Limits from Part 05 keep definitions small; measured load time for largest allowed definition. |
| FR-21.10 | Redis | Memory bounded via `removeOnComplete/Fail`; `maxmemory-policy noeviction` required for BullMQ (documented). |
| FR-21.11 | Backpressure | When queue waiting count exceeds threshold, webhook intake still accepts (DB is the buffer) but manual triggers return `429`; alert log emitted. |
| FR-21.12 | Graceful shutdown & stalled jobs | Verified under load: rolling restart loses no runs. |

## Technical Requirements

- Load test tool: k6 or autocannon script in `scripts/load/`; scenarios: 50 webhook req/s for 2 min; 1 000 queued runs with 5 workers × concurrency 5 using `util.log` nodes.
- Seed script for 1M runs in a local perf database (not CI).
- Record results in this document: p50/p95 latency, throughput, DB CPU, queue drain time.

## API Changes

None expected (except 429 on manual trigger under backpressure).

## Database Changes

Possible index adjustments based on findings; retention job.

## Security Requirements

Retention deletes must stay tenant-safe (batch by time, not by user input).

## Testing Requirements

Load test runs documented; retention job integration test; multi-worker integration test (two worker instances, 100 runs, each executed exactly once by the engine).

## Deliverables

Load test scripts and results, EXPLAIN outputs for hot queries, retention job, configuration guidance, decision log.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-21.1 | Two API + two worker instances process 1 000 runs with no duplicate step execution | Integration/load evidence |
| AC-21.2 | Hot queries use indexes at 1M runs | EXPLAIN output recorded |
| AC-21.3 | Webhook intake p95 < 200 ms at 50 req/s locally | Load test output |
| AC-21.4 | Retention job deletes expired data in batches | Integration |
| AC-21.5 | Pool sizing documented and configured | Doc + config |
| AC-21.6 | Bottlenecks and decisions recorded with measurements | This document |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Sharding, read replicas, multi-region, autoscaling policies.

## Dependencies

Parts 07–16, 20.

## Risks / Design Questions

- Local measurements are indicative only; stated as such.

## Implementation Notes

Decision log (append as measured):

| Date | Finding | Decision |
| --- | --- | --- |
| 2026-10-02 | Deleting runs: `retryOfRunId` (FK, ON DELETE SET NULL) had no index — deleting 50 runs at 1M rows took **18.7 s** (a full scan per deleted run) | Index added; same delete **25 ms**, 1 000 runs 466 ms |
| 2026-10-02 | Keyset pages: Prisma's `OR` cursor is only a filter, so Postgres read and discarded every newer row — **295 ms** at 200k rows deep | Redundant `createdAt <= cursor` added (becomes an index condition): **1.9 ms**. Applied to runs and workflows; a regression test checks the SQL |
| 2026-10-02 | Webhook intake p95 **38 ms** at 50 req/s with workers stopped, but **1.76 s** with 2 workers executing concurrently; 23 of 5 888 requests got 500 (pool wait > 2 s) | Cause: WAL fsync — sessions wait on `WALWrite`/`WalSync`; this disk does ~640 fsync/s (Docker Desktop/WSL2) and each run commits ~9 times. Claim reduced to one statement; intake now waits up to 5 s for a connection instead of failing (GitHub does not redeliver). Not re-measured — accepted for now; re-test on server-class storage |
| 2026-10-02 | Worker throughput: 2 workers × concurrency 5 drained 6 001 runs in 151 s (~40 runs/s, `util.log`) | Scale workers horizontally; per-run commits are the cost driver (merging step writes further would conflict with AC-08.4, state persisted at each transition) |
| 2026-10-02 | Dashboard 7-day count on the hot tenant: 333 ms cold, 47 ms warm (23k runs/week) | No new index; revisit if a tenant exceeds ~100k runs/week |
| 2026-10-02 | Prisma's default pool is CPUs × 2 + 1, so a 1–2 CPU container got 3–5 connections — fewer than WORKER_CONCURRENCY | Pool set explicitly (`DATABASE_CONNECTION_LIMIT`, default 10); startup refuses a pool < concurrency + 2 |
| 2026-10-02 | One slow provider could occupy every worker slot | Per-provider limit per worker (default ⌈concurrency/2⌉); a busy provider postpones the run (delayed job, no attempt used) |

## As implemented

| Area | Implementation |
| --- | --- |
| FR-21.1 stateless API | Sessions (JWT + refresh rotation in Postgres), OAuth state (Postgres), rate limits (Redis, Part 18); verified with two app instances (`scalability.int-spec.ts`, `api-hardening.int-spec.ts`) |
| FR-21.2 horizontal workers | Fenced run claim (Part 15) + `jobId = runId`; the claim is now a single `UPDATE … RETURNING` |
| FR-21.3 provider concurrency | `ProviderConcurrencyLimiter` (`src/engine/execution/provider-slots.ts`): a slot is taken before the step's RUNNING marker; when full the engine throws `ProviderSlotsBusyError`, the worker releases the claim (`releaseRun`, attempt count restored) and the processor moves the job to delayed (0.5–1.5 s) with BullMQ `DelayedError` — no attempt consumed. `PROVIDER_CONCURRENCY` (default ⌈WORKER_CONCURRENCY/2⌉), per worker process |
| FR-21.4 pool | `DATABASE_CONNECTION_LIMIT` (default 10) overrides `connection_limit`; env validation refuses a pool < WORKER_CONCURRENCY + 2 |
| FR-21.5 indexes | New: `WorkflowRun(retryOfRunId)`, `(payloadsTrimmedAt, createdAt)`, `(createdAt)` — migration `20261002120000_retention_and_indexes` |
| FR-21.6 pagination | Keyset everywhere (runs, workflows, versions); a unit test forbids `skip:`/`OFFSET` in `src` |
| FR-21.7 N+1 | Integration test counts Prisma queries: run list costs the same for 5 and 20 runs (≤ 5) and never touches `StepRun`; workflow list never selects definitions |
| FR-21.8 retention | `RetentionService` on the maintenance queue (hourly): deliveries > 30 d deleted; finished runs > 30 d have step input/output cleared and `payloadsTrimmedAt` set; finished runs > 90 d deleted with their steps. Batches of `RETENTION_BATCH_SIZE` (1 000) with `FOR UPDATE SKIP LOCKED`, at most `RETENTION_MAX_BATCHES` per tick; rows selected by age and status only (tenant-safe). Resume-retry of a trimmed run → 409 `PAYLOADS_TRIMMED`; run detail shows `payloadsTrimmedAt` |
| FR-21.10 Redis | Jobs removed on completion/failure (Part 07); BullMQ warns at startup unless `maxmemory-policy noeviction` (the Redis default, kept in Compose) |
| FR-21.11 backpressure | `QueueBackpressure`: waiting count sampled at most once per second (500 ms timeout, fails open); above `QUEUE_BACKPRESSURE_THRESHOLD` (5 000) manual runs and retries get 429 + `Retry-After: 30`; webhooks are always accepted; `alert: queue_backpressure` warn log at most every 30 s |

### Pool sizing formula

`(API instances × pool) + (workers × pool) + 10 (migrations, psql, monitoring) ≤ 0.8 × max_connections`, with a worker pool ≥ WORKER_CONCURRENCY + 2. Example with Postgres' default `max_connections = 100`: 2 APIs × 10 + 3 workers × 10 + 10 = 60 ✓.

## Implementation Evidence

Measured 2026-10-02 on a developer laptop (Docker Desktop/WSL2, 14 CPUs and 8 GB for Docker, Postgres 17 defaults, ~640 fsync/s). Indicative only. Isolated Compose project `flowforge-perf` (`scripts/load/perf.compose.yml`, no `.env`, throwaway secrets), removed afterwards. Seed: 1 000 000 runs, 2 000 000 steps, 300 000 deliveries, 100 workspaces (hot tenant 400 000 runs), 1.4 GB.

| ID | Result | Evidence |
| --- | --- | --- |
| AC-21.1 | PARTIAL | Integration (`scalability.int-spec.ts`): 2 APIs + 2 workers, 100 runs → all SUCCEEDED, every run and step `attemptCount = 1`, the non-idempotent step called exactly 100 times for 100 distinct runs, both workers took part. Load: 13 867 webhook-created runs via 2 APIs executed by 2 worker containers, all SUCCEEDED; the duplicate-check query (`check-runs.sql`) was not run before the stack was removed |
| AC-21.2 | PASS | `scripts/load/explain-hot-queries.sql` at 1M runs: run list 0.5 ms; filtered by status 2.7 ms, by workflow 2.2 ms; deep keyset page 1.9 ms (after the fix); step list 0.4 ms; membership 2.4 ms; trigger match 1.8 ms; recent failures 0.2 ms; sweeper 0.1 ms; retention batches 3–248 ms — all index scans |
| AC-21.3 | PASS (intake alone) / FAIL (with workers, locally) | k6, 50 req/s × 2 min over 2 APIs: workers stopped → p95 **38 ms**, p99 52 ms, 0 of 6 001 failed. With 2 workers executing concurrently → p95 1.76 s, 23 × 500. Cause and decision in the log above |
| AC-21.4 | PASS | `retention.int-spec.ts`: expired deliveries and runs deleted and old payloads trimmed across two workspaces; unfinished and recent runs untouched; retries survive their deleted original; the batch budget continues on the next tick; trimmed runs refuse resume (409) but retry from the start (202) |
| AC-21.5 | PASS | `DATABASE_CONNECTION_LIMIT` + validation, formula above, `.env.example` |
| AC-21.6 | PASS | Decision log above |

Not done: FR-21.9 (load time of the largest definition) not measured; FR-21.12 rolling restart *under load* not exercised (graceful stop verified in Part 20, stalled-job recovery in Part 15); the 5 workers × 5 drain scenario not run.

Tests added: `provider-slots.spec.ts`, `queue-backpressure.service.spec.ts`, `scalability-architecture.spec.ts`, engine slot tests, env tests; `retention.int-spec.ts` (3), `scalability.int-spec.ts` (7). One unexplained failure of the 100-run test in 10 full-file runs (no detail captured; 8 consecutive passes after) — watch in CI. Also fixed a pre-existing 1-in-250 flake in `api-hardening.int-spec.ts` (a random client IP could repeat).
