# 21 — Performance and Scalability

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

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
| — | — | — |
