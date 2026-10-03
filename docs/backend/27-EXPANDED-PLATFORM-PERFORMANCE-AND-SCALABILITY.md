# 27 — Expanded-Platform Performance and Scalability Validation

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

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
