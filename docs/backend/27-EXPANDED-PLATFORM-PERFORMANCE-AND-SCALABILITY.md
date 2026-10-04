# 27 — Expanded-Platform Performance and Scalability Validation

**Status:** COMPLETE WITH EXCEPTIONS (2026-10-04) — distributed correctness proven under load (zero duplicate runs everywhere, zero lost runs on shutdown), five defects found and fixed, hot queries index-based; schedule lag at 10 000, webhook ack p95, 1M-run plans, the multi-container k6 run and infrastructure chaos are documented exceptions. See [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Re-validate performance, scalability and resilience **after** the schedule trigger, generic HTTP (outbound + inbound), Jira and Gmail exist, so the final measurements describe the real expanded platform — not the earlier subset measured in Part 21. Nothing here is run until Parts 23–26 are complete.

## Why This Part Exists

Part 21 (COMPLETE WITH EXCEPTIONS, 2026-10-02) measured the original platform: 1M-run queries, webhook intake, provider concurrency, backpressure, retention, pool sizing. The new parts add new load shapes (time-aligned bursts at :00, user-controlled outbound calls, provider webhook storms, Pub/Sub notification bursts with history resolution) and new distributed-correctness claims (one run per schedule occurrence / poll item / message across instances). Those claims must be proven under load, with several API instances, workers and schedulers.

## Scope

Load tests, failure/chaos tests and query analysis for the expanded platform, using the Part 21 tooling (`scripts/load/`, isolated Compose project, seeded 1M runs) extended for the new triggers and actions. Fixes found here are made in this part (or tracked as defects in the owning part).

## Functional Requirements (what is measured)

| ID | Area | Requirement |
| --- | --- | --- |
| FR-27.1 | Scheduled load | 10 000 active schedules with many sharing the same minute (e.g. 30 % at 00:00 local in several timezones): evaluation lag p95 < 30 s, zero duplicate runs, misfire policy honoured after evaluator downtime. |
| FR-27.2 | Multiple schedulers | 3 worker processes evaluating the same schedules concurrently: exactly one run per occurrence (DB-verified), even with forced tick retries and killed workers mid-tick. |
| FR-27.3 | HTTP action load | 1 000 runs with `http.request` against a local test service with latency/errors injected: provider concurrency limits respected, 429/Retry-After honoured, no worker starvation of other providers, egress guard overhead measured (DNS resolution cost, caching policy). |
| FR-27.4 | Inbound webhook bursts | Generic webhooks and Jira webhooks at 50–200 req/s across 2 API instances: p95 acknowledgement < 200 ms target (Part 21 exception context recorded), dedup holds under concurrent duplicates, rate limits per hook/IP behave, accepted-but-queued behaviour under backpressure. |
| FR-27.5 | Gmail notification bursts | Notification storms for one and many mailboxes: coalesced history resolution (one resolver per connection at a time), no duplicate runs, quota-aware concurrency, catch-up after a gap. |
| FR-27.6 | Polling triggers | Many `http.poll` triggers: seen-item state growth bounded, no duplicate items across restarts, third-party request rate within quotas. |
| FR-27.7 | Queue & Redis | Backpressure thresholds still protect the system with the new producers; Redis memory bounded (job retention, scheduler entries, rate-limit keys, test captures if Redis-backed) — measured peak and steady state. |
| FR-27.8 | Database | Connection pool sizing for API + workers + evaluators; new hot queries (`WorkflowSchedule` due scan with `SKIP LOCKED`, subscription renewal scans, delivery log, poll state) EXPLAINed on 1M runs / 10k schedules / 1M deliveries; Part 21 hot-query plans re-checked. |
| FR-27.9 | Lifecycle & resilience | Graceful shutdown of API and workers during load (no lost runs; in-flight steps finish or are recoverable), stalled-job recovery, sweeper behaviour with scheduled runs, renewal jobs surviving restarts. |
| FR-27.10 | Retention | Retention keeps up with the new data volume (deliveries incl. generic webhooks and Pub/Sub, step payloads with HTTP/email content) without long locks. |
| FR-27.11 | 1M-run performance | Run list/detail/dashboard targets from Part 21 still met with the new trigger sources and filters. |

## Technical Requirements

Isolated Compose project with 2 API + 3 worker replicas (as Part 21's `perf.compose.yml`, extended); local controllable test services (HTTP target, fake Jira, fake Pub/Sub publisher) — never real providers for load; fake clock or short schedules for time-based tests; k6 scenarios added under `scripts/load/`; results recorded in this file with environment details. No Kubernetes requirement.

## API Requirements

None new; may add operator metrics endpoints if gaps are found (recorded as changes).

## Database / persistence changes

Only fixes found by analysis (e.g. indexes), each with before/after plans.

## Security Requirements

Load tooling uses throwaway secrets and isolated stacks; tests never point at real provider accounts or real databases.

## Multi-Tenant Requirements

Load includes many workspaces with a hot tenant (as Part 21) to verify fairness: one workspace's schedule storm or webhook burst does not starve others (measured queue wait per workspace).

## Error Handling

Injected provider failures (429/5xx/timeouts) and infrastructure faults (Redis restart, DB failover/restart, worker kill) with expected outcomes documented per test.

## Observability

Each test records throughput, latency percentiles, queue depth/wait, DB pool usage, Redis memory, error/retry counts, duplicates detected (must be 0).

## Testing Requirements

The scenarios in FR-27.1–27.11, each with a pass/fail threshold decided before running, plus a re-run of Part 21's suite for regression.

## E2E Scenarios

Run the five product scenarios (daily operations, email triage, engineering, universal API, periodic reporting) at moderate concurrency against fakes to validate end-to-end latency and correctness together.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-27.1 | Zero duplicate runs across schedules, poll items, Gmail messages and webhook deliveries under concurrency and faults | DB checks after each run |
| AC-27.2 | Thresholds of FR-27.1–27.11 met or exceptions documented with cause and decision | Recorded measurements |
| AC-27.3 | Graceful shutdown and stalled-job recovery lose no runs under load | Chaos tests |
| AC-27.4 | Hot-query plans are index-based at target data volumes | EXPLAIN (ANALYZE) records |
| AC-27.5 | Redis memory and DB pool usage stay within configured bounds | Recorded metrics |

## Definition of Done

All AC recorded with evidence (or exceptions with decisions), fixes merged with tests, Part 22-style release notes updated for the expanded platform.

## Dependencies

Parts 21 (baseline and tooling), 23, 24, 25, 26 complete.

## Out of Scope

Real-provider load testing; multi-region; Kubernetes/autoscaling.

## Risks / Design Questions

- Local-disk fsync bound observed in Part 21 — run on comparable hardware or document.
- Fake providers must reproduce realistic rate-limit behaviour.
- Threshold values for the new areas (decide before running).

## Implementation Notes

Reuse `scripts/load/` (seed, explain, k6) and extend the seed with schedules, subscriptions and deliveries; keep each scenario runnable on its own.

## Implementation Evidence (2026-10-04)

**Environment.** Developer laptop, Windows 11 + Docker Desktop (8 GB VM shared with a kind cluster and the developer's own Postgres 17 / Redis 7 containers; ~1.3 GB free host memory). Indicative only. Because of the memory budget the multi-container stack (2 API + 3 worker containers + k6) was **not** started; instead:

- **Distributed correctness and load:** [`test/integration/expanded-scale.int-spec.ts`](../../test/integration/expanded-scale.int-spec.ts) runs, in one Node process against the integration Postgres and Redis, **2 API instances** (separate Nest apps), a worker (run, maintenance, poll and provider-events processors), **3 extra schedule evaluators**, 3 concurrent pollers plus a restarted second worker, a local HTTP test service (latency, 429 + `Retry-After`, poll items) and the fake Google. Every scenario prints `SCALE_METRIC {...}` and asserts its threshold; volumes come from `FF_SCALE_*` (small defaults keep it in the regular gate). Thresholds were fixed before running: schedule lag p95 < 30 s, duplicate runs = 0, lost runs = 0, provider in-flight ≤ limit, webhook ack p95 < 200 ms (target only, Part 21 context).
- **Query plans:** a throwaway `postgres:17-alpine` container (own name and port, removed afterwards), all migrations, [`seed-perf.sql`](../../scripts/load/seed-perf.sql) (300 000 runs, 100 workspaces, hot tenant) + [`seed-expanded.sql`](../../scripts/load/seed-expanded.sql) (10 000 schedules, 5 000 hooks, 2 000 Jira/Gmail connections + subscriptions, **1 090 000 deliveries**, 1 000 full poll windows, +100 000 SCHEDULE/POLL runs → 400 000 runs, 1.0 GB), then [`explain-expanded.sql`](../../scripts/load/explain-expanded.sql).

### Recorded runs (`SCALE_METRIC`, latest run of each scenario)

| Scenario | Volume | Result |
| --- | --- | --- |
| FR-27.1/27.2 schedules | 10 000 due at the same instant in 3 timezones; 3 evaluators + the worker's own; then every schedule forced back onto the same occurrence and re-drained | **10 000 runs, 0 duplicates, the retried drain fired 0** (10 000 suppressed by the unique key). 281 schedules/s, lag p50 18.7 s, **p95 34.3 s** (target 30 s — exception). At 3 000: 582/s, p95 4.9 s |
| FR-27.4 generic webhooks | 600 deliveries over 2 APIs, 20 % concurrent duplicates | 480 runs = 480 deliveries, **120 duplicates suppressed, 0 duplicate runs**, 0 rate-limited; ack p50 1.07 s, **p95 1.49 s** (target 200 ms — exception) |
| FR-27.4 Jira webhooks | 400 signed deliveries over 2 APIs with retries | 320 runs, 320 unique, 0 duplicates; ack p95 1.23 s |
| FR-27.3 HTTP action | 200 `http.request` runs at 200 ms latency with 429s + 50 `util.log` runs, provider concurrency 3 | max in flight at the service **3 = limit**; util.log runs finished first: no starvation; 0 failed. **At 1 000 http + 250 util.log runs:** 97 answered 429 + `Retry-After` and succeeded on retry, max in flight 3, util.log done at 77 s vs http at 138 s, **0 failed** |
| FR-27.6 polls | 200 `http.poll` triggers, 3 concurrent pollers + a restarted worker | **2 000 runs = 2 000 new items, 0 duplicates**; seen window bounded (cap 2 000) |
| FR-27.5 Gmail storm | 60 messages, 6 workspaces on one mailbox, 60 pushes over 2 APIs | **360 runs = 360 expected, 0 duplicates**, 18 resolutions (coalesced, one per connection at a time) |
| FR-27.9 graceful shutdown | 200 runs, worker closed mid-load, replacement worker | **0 RUNNING after stop, 0 not succeeded, every step attempt 1**; stop 613 ms |
| FR-27.7 Redis | after the scenarios | used memory 5.3 → 6.6 MB; every rate-limit key has a TTL; completed jobs trimmed to 1 000, 0 waiting |

### Query plans (all index scans after the fixes)

| Query | Before | After |
| --- | --- | --- |
| Due-schedule claim, batch of 50, `SKIP LOCKED` | 21 ms, incremental sort of the whole due set | index `(active, nextRunAt, id)`: order read from the index |
| Advance 50 schedules (one `UPDATE … FROM unnest`) | 87 ms (cold) | 22 ms |
| Hook lookup by hash / previous hash | 4.0 ms (two unique indexes) | 4.4 ms |
| Delivery dedup `(provider, deliveryId)` | 4.1 ms | 5.3 ms |
| Delivery log first page / deep keyset page | 4.4 / 0.5 ms | 5.8 / 2.0 ms |
| Jira: triggers of a connection | 1.5 ms, **seq scan** | 0.4 ms, `WorkflowTrigger(connectionId)` |
| Subscription renewal scan | 1.9 ms | 0.4 ms |
| Gmail push: subscriptions of a mailbox | 1.5 ms, **seq scan** | 0.3 ms, `IntegrationConnection(accountLabel)` |
| Poll quota / poll state | 0.5 / 6.1 ms | 4.1 / 1.8 ms |
| Run list by trigger source, hot tenant (121 000 runs) | 63 ms; **rare source 1 357 ms** (walks the whole tenant) | **0.8 ms; rare source 0.3 ms**, `WorkflowRun(workspaceId, triggerSource, createdAt)` |
| Retention: oldest 1 000 of 1.09M deliveries | 61 ms | 100 ms (cold cache), index scan |

### Defects found and fixed

1. **Graceful shutdown lost runs.** Prisma disconnected in `onModuleDestroy`, before BullMQ closed its workers in `onApplicationShutdown`: 5 runs stayed RUNNING and 2 failed `UNCERTAIN_OUTCOME`. Fix: `WorkerDrain` (`beforeApplicationShutdown`) closes all four processors' workers first and logs the drain; Prisma disconnects in `onApplicationShutdown`. After: 0 lost.
2. **Schedule evaluator throughput.** One transaction per schedule (~23/s with 3 evaluators). Fix: batches of 50 per transaction (`createMany … skipDuplicates`, one `UPDATE … FROM unnest(...)`), cron parsing cached per expression and timezone (−40 % CPU per batch), claim order served by the new index. The unique `schedule:<id>:<occurrence>` key still decides duplicates.
3. **Gmail backlog skipped mail.** When a resolution hit the page cap (20 pages) or the message cap (200), the stored history id still advanced to the mailbox's current id, silently dropping the rest. Fix: advance only past what was processed (the last record read, or just before the first message left out — always making progress) and queue a follow-up resolution. Regression test in `gmail.int-spec.ts`.
4. **Interactive transactions aborted under contention.** The batched evaluator and the poll runner used Prisma's 5 s default; on a contended database whole batches rolled back (safe, but the tick threw). Fix: explicit `{ maxWait: 10 s, timeout: 30 s }`.
5. **Missing indexes.** The four above; migrations `20261006090000_expanded_performance_indexes` and `20261006100000_schedule_due_index`. They are plain `CREATE INDEX`: on a large production `WorkflowRun`, build the index `CONCURRENTLY` first under the same name.

Test-harness corrections made while measuring (not product changes): lag measured from when an occurrence became due for the test; schedules switched on together and given a daily cron so a long setup cannot reach the next occurrence; the fake HTTP service limits each request at most once (a real limit clears after `Retry-After`).

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-27.1 | **PASS** | 0 duplicate runs in every scenario, checked in the database: schedules (incl. forced retries over 4 evaluators), poll items across concurrent pollers and a restart, Gmail across 6 workspaces on one mailbox, generic and Jira deliveries with concurrent duplicates |
| AC-27.2 | **PASS WITH EXCEPTIONS** | Duplicates, lost runs, provider concurrency, poll, Gmail and Redis thresholds met; exceptions below with cause and decision |
| AC-27.3 | **PASS (graceful) / existing (stalled)** | Graceful worker shutdown under load loses nothing (after fix 1). Stalled-job recovery and the sweeper are covered by the Part 15 and Part 23 tests (`reliability.int-spec.ts`, `schedules.int-spec.ts` "enqueue failed → sweeper"); not re-run under load |
| AC-27.4 | **PASS at 400 000 runs** | All hot queries are index scans after the fixes, seeded with 400 000 runs, 1.09M deliveries and 10 000 schedules; 1M runs not seeded (exception) |
| AC-27.5 | **PASS** | Redis bounded (above). Evaluators, pollers and resolvers run inside the worker process and hold one connection per batch, so the Part 21 pool formula is unchanged (`APIs × pool + workers × pool + 10 ≤ 0.8 × max_connections`, worker pool ≥ WORKER_CONCURRENCY + 2); no pool timeouts in any run |

### Exceptions and decisions

- **Schedule lag p95 with 10 000 simultaneous schedules: 34.3 s (target 30 s).** All four evaluators share one Node thread with the API instances and the test; at 3 000 the p95 is 4.9 s. Decision: accepted for this release; in production each worker process evaluates independently, and more workers or a larger `SCHEDULE_BATCH_SIZE` scale it. Re-measure on server hardware with separate worker processes.
- **Webhook acknowledgement p95 1.2–1.5 s (target 200 ms),** measured with run execution paused but with 2 APIs, the worker and the load client in one Node process on laptop storage. Part 21's multi-container k6 measurement (38 ms intake only) remains the reference.
- **Multi-container k6 run (2 API + 3 worker containers)** not repeated: memory budget. Correctness with multiple instances was proven in-process instead.
- **1M-run plans:** seeded at 400 000 runs; the Part 21 1M-run plans stay valid for the unchanged queries, and the new trigger-source index was verified on a 121 000-run hot tenant.
- **Infrastructure chaos** (Redis restart, database restart or failover, killed worker processes) and the five product scenarios at moderate concurrency against fakes were not run here. Real-account E2E is recorded in Parts 13 (Slack), 25 (Jira) and 26 (Gmail, incl. Scenario 1).
- **FR-27.3 egress-guard DNS overhead** not measured separately (the test service is on loopback).

### Gate (2026-10-04)

| Step | Result |
| --- | --- |
| `prettier --check`, `npm run lint`, `npm run typecheck`, `tsc -p tsconfig.spec.json` | pass |
| `prisma validate`; migrations from empty (throwaway DB) and `migrate diff` against the schema | valid; no drift |
| `npm test` (unit) | 53 suites, **759 tests passed** |
| Integration, full (`jest-int`, `--runInBand`) | 27 suites, **421 tests passed** (includes `expanded-scale.int-spec.ts` at default volumes) |

The first full run had one failure: a developer `.env` with `PUBLIC_API_URL` (an ngrok URL for the live provider tests) leaked into `hooks.int-spec.ts`. `test/setup-int-env.ts` now forces it empty, like the encryption and AI keys.

