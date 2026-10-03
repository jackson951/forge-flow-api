# 23 — Schedule / Time Trigger

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

## Objective

Let a published workflow start automatically on a recurring schedule — every N minutes, hourly, daily, on weekdays, weekly, monthly or by a custom cron expression — in an explicit IANA timezone, with **exactly one run per scheduled occurrence** no matter how many workers or API instances are running.

## Why This Part Exists

Today runs start only from a webhook, a manual call or a retry. Reporting, polling-style checks and periodic housekeeping are among the most common automations; without a time trigger FlowForge cannot express "every weekday at 07:00". It must reuse the existing pipeline — a scheduled occurrence is just another way of creating a durable `QUEUED` run:

```
WorkflowSchedule (from the published version)
   ↓  schedule tick (maintenance queue, any worker)
occurrence due → INSERT WorkflowRun (QUEUED, idempotencyKey = schedule:<id>:<ISO occurrence>)
   ↓  after commit
BullMQ (workflow-runs, jobId = runId) → worker → ExecutionEngine → SUCCEEDED / FAILED
```

No separate execution path; the engine does not know a run came from a schedule except through `triggerSource` and the trigger input.

## Scope

- New trigger node type `schedule.trigger` with a validated, timezone-explicit schedule config.
- `WorkflowSchedule` persistence created/updated/removed by the publish, archive, unarchive and delete paths (like `WorkflowTrigger` for webhooks today).
- A schedule evaluator job on the existing **maintenance queue** (`upsertJobScheduler`, shared by all workers — the same mechanism as the run sweeper and retention).
- Duplicate prevention through the existing unique index `WorkflowRun(workspaceId, idempotencyKey)`.
- `TriggerSource.SCHEDULE`; trigger output metadata; observability; documented missed-occurrence policy.

## Existing architecture this part builds on (inspected 2026-10-03)

| Component | Today | Use here |
| --- | --- | --- |
| `MaintenanceProcessor` (`src/execution/processors.ts`) | BullMQ job schedulers `sweep-queued-runs`, `apply-retention`, upserted idempotently by every worker | add `evaluate-schedules` |
| `RunSweeper` | re-enqueues runs `QUEUED` longer than `QUEUE_SWEEPER_STALE_AFTER_MS` | covers "run row created, enqueue failed" for scheduled runs too |
| `WorkflowRun @@unique([workspaceId, idempotencyKey])` | used by manual runs and retries | occurrence identity → at most one run per occurrence |
| `WorkflowTrigger` (`workflowId @unique`, `provider` required) | webhook routing per published version | **not reused**: a schedule has no provider/resourceKey; a dedicated table avoids overloading it |
| Publish path (`publishing.service.ts`) | writes `WorkflowTrigger` from `NodeTypeDefinition.route` | gains a `schedule` hook writing `WorkflowSchedule` |
| Backpressure (`queue-backpressure.service.ts`) | 429 for manual runs above the queue threshold | scheduled runs are **not refused** (like webhooks) but counted/logged |

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-23.1 | `schedule.trigger` config (strict zod): `{ schedule: { kind, timezone, ... } }` with `kind` one of `interval` (`everyMinutes` 1–1440, aligned to the start of the hour/day in the timezone), `hourly` (`minute` 0–59), `daily` (`time` HH:mm), `weekdays` (Mon–Fri, `time`), `weekly` (`daysOfWeek` 1–7 non-empty unique, `time`), `monthly` (`dayOfMonth` 1–31 or `last`, `time`), `cron` (`expression`, 5-field standard cron; no seconds field). Each friendly kind compiles to a cron expression internally, so one evaluator handles all. |
| FR-23.2 | `timezone` is **required**, an IANA identifier validated with `Intl.supportedValuesOf('timeZone')` / `Intl.DateTimeFormat`; never defaulted from the server. Invalid timezone or cron → validation issue `INVALID_NODE_CONFIG` with a clear message (draft save, validate, publish). |
| FR-23.3 | Minimum interval: 1 minute (cron with a `*` minute field is allowed only if the operator config `SCHEDULE_MIN_INTERVAL_MINUTES` permits it; default 5). |
| FR-23.4 | Publishing a version whose trigger is `schedule.trigger` upserts the workflow's `WorkflowSchedule` (version id, compiled cron, timezone, `nextRunAt` = next occurrence after now). Publishing a version with another trigger, archiving or deleting the workflow removes/deactivates it. Unarchive does **not** reactivate automatically unless the active version is a schedule (then it recomputes `nextRunAt` from now — no backfill). |
| FR-23.5 | Changing the schedule (publishing a new version) replaces the definition atomically in the publish transaction; occurrences already turned into runs keep their run; `nextRunAt` is recomputed from now. |
| FR-23.6 | Evaluator tick (default every 30 s, `SCHEDULE_TICK_INTERVAL_MS`): select active schedules with `nextRunAt <= now` (batched, ordered, `FOR UPDATE SKIP LOCKED` to spread work across workers); for each due occurrence create the run with `idempotencyKey = schedule:<scheduleId>:<occurrence ISO-8601 UTC>`, `triggerSource = SCHEDULE`, bound to the schedule's version; advance `nextRunAt` to the next occurrence strictly after the handled one; enqueue after commit. |
| FR-23.7 | **Missed-occurrence policy (default, documented): "fire the latest missed occurrence once, skip older ones."** If the evaluator was down and several occurrences passed, one run is created for the most recent due occurrence (if it is within `SCHEDULE_MISFIRE_GRACE_MS`, default 1 h), the rest are recorded as skipped in logs/metrics, never backfilled. Occurrences older than the grace window are skipped entirely. A per-schedule `catchUp: 'none' \| 'latest'` field may be added later; only the default is in scope. |
| FR-23.8 | DST: occurrences are computed in the schedule's timezone by the cron library. A wall-clock time that does not exist (spring forward) runs at the next valid instant once; a time that occurs twice (fall back) runs **once** (first occurrence). Documented and tested with `America/New_York`, `Europe/London` and `Africa/Johannesburg` (no DST). |
| FR-23.9 | Trigger output (becomes `trigger.*`), produced by the system, never from user input: `{ triggerType: 'SCHEDULE', scheduledFor, triggeredAt, timezone, scheduleId }`. Manual "Run now" of a schedule workflow is allowed (Part 08 frontend) and produces `{ triggerType: 'MANUAL', ... }` — manual input cannot set `triggerType` or `scheduledFor` (input is nested under a separate key or rejected; decided in implementation and tested). |
| FR-23.10 | Workspace/run limits apply as for other triggers; a schedule whose workflow is archived, whose workspace is deleted, or whose version is no longer active never creates a run (checked inside the creating transaction). |

## Technical Requirements

- Cron evaluation library with IANA timezone support and DST handling (candidates: `croner`, `cron-parser`); pinned, licence-checked, wrapped in `src/engine/schedule/` with our own types so it can be swapped.
- Evaluator in the **worker** process (maintenance queue). It never runs workflows itself; it only creates runs and enqueues them.
- Distributed correctness from the database only: `SKIP LOCKED` spreads load; the unique `idempotencyKey` guarantees one run per occurrence even if two evaluators race or a tick is retried. No in-memory or Redis-only lock is relied upon for correctness.
- `nextRunAt` advance and run insert in one transaction; enqueue after commit; the sweeper covers enqueue failures.
- Clock: use database `now()` for due checks to avoid skew between worker hosts (or document the NTP assumption).

## API Changes

No new public endpoints are required. Existing endpoints change:

- `GET /node-types` lists `schedule.trigger`.
- `GET /workspaces/:ws/workflows/:id` (and list) gains an optional read-only `schedule` summary for the active version: `{ active, timezone, description, nextRunAt, lastRunAt }`.
- Draft validate/save/publish report schedule config issues.
- Run list/detail accept and return `triggerSource = SCHEDULE` (filter value added).
- Optional (decide): `GET /workspaces/:ws/workflows/:id/schedule/preview?count=5` returning the next occurrences for the editor.

## Database / persistence changes

- `enum TriggerSource` + `SCHEDULE`.
- New `WorkflowSchedule`: `id`, `workspaceId`, `workflowId @unique`, `workflowVersionId`, `cron` (compiled), `timezone`, `config Json` (original friendly config), `active Boolean`, `nextRunAt timestamptz`, `lastOccurrenceAt`, `lastRunId`, `createdAt`, `updatedAt`; index `(active, nextRunAt)`; cascades from workflow/workspace/version.
- No change to `WorkflowRun` (the idempotency key carries the occurrence identity; optional `scheduledFor` column can be added for querying — decide).

## Security Requirements

- Only ADMIN/OWNER can publish (existing rule) — therefore only they create schedules.
- Trigger metadata is system-generated; user input cannot spoof `triggerType`, `scheduledFor`, `scheduleId`.
- No secrets in schedule config; logs carry ids and times only.

## Multi-Tenant Requirements

- `WorkflowSchedule.workspaceId` is set from the workflow; the evaluator creates runs with the schedule's workspace id and verifies (in the transaction) that the workflow/version still belong to it and the workflow is not archived.
- Tenant-isolation suite: schedules of another workspace are never visible through workflow endpoints.

## Error Handling

- Invalid schedule rejected at validate/publish; a schedule that becomes invalid (e.g. timezone removed from the runtime) is deactivated with an audit/log entry and surfaces on the workflow summary.
- Evaluator failures (DB down) retry on the next tick; the misfire policy decides what happens to late occurrences.
- Enqueue failure → run stays `QUEUED` → sweeper.

## Observability

Structured logs (no secrets) for: occurrence fired (`scheduleId`, `workflowId`, `workspaceId`, `scheduledFor`, `enqueuedAt`, lag ms, `runId`, `correlationId`, worker instance id), duplicate suppressed (unique violation), occurrence skipped (misfire policy), schedule deactivated. Metrics/counters for fired, skipped, duplicate-suppressed, evaluation lag.

## Testing Requirements

- Unit: config schema per kind; cron compilation; next-occurrence calculation; timezone validation; DST spring-forward/fall-back cases; misfire policy.
- Integration (real Postgres/Redis): publish creates the schedule; new version replaces it; archive/delete remove it; unpublished/archived workflow never runs; changed schedule; due occurrence → exactly one run; **two evaluators in parallel on the same due schedule → one run** (and a retried tick → no second run); evaluator restart; misfire after downtime; enqueue failure recovered by the sweeper.
- E2E: schedule (fake clock / short interval) → durable run → BullMQ → worker → engine → terminal status, with `trigger.scheduledFor` visible in step output.

## E2E Scenarios

- **S23.1** Every minute (test config) → `util.log` with `{{ trigger.scheduledFor }}` → SUCCEEDED, one run per occurrence across 2 workers.
- **Scenario 1 (combined, after Parts 24/26):** weekday 07:00 → HTTP fetch → condition failures > 0 → Gmail report.
- **Scenario 5 (after Parts 25/26):** Friday 16:00 → Jira search → AI summarise → Gmail.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-23.1 | Every supported kind validates, compiles and yields the expected next occurrences in its timezone, including DST transitions | Unit tests |
| AC-23.2 | Publish/new version/archive/delete keep `WorkflowSchedule` consistent; inactive workflows never run | Integration tests |
| AC-23.3 | Two concurrent evaluators and retried ticks produce exactly one run per occurrence (database-enforced) | Integration test with real Postgres |
| AC-23.4 | A scheduled occurrence runs through the existing queue/worker/engine to a terminal status with system trigger metadata | E2E |
| AC-23.5 | Downtime follows the documented misfire policy; enqueue failure is recovered by the sweeper | Integration tests |
| AC-23.6 | Logs contain the listed fields and no secrets | Log assertion test + secret canary suite |

## Definition of Done

Roadmap DoD (build, lint, typecheck, tests, migration, security, docs/Swagger, no critical defect) plus all AC above with evidence.

## Dependencies

Parts 06 (publishing), 07 (queue/maintenance), 08 (engine), 15 (idempotency), 16 (run history). No dependency on Parts 24–26.

## Out of Scope

Seconds-level schedules; one-off "run at" datetimes; calendars/holidays; per-schedule catch-up configuration beyond the default; user-visible schedule pause separate from archiving (possible later).

## Risks / Design Questions

- Library choice and its DST semantics must match FR-23.8 exactly — verify with tests before committing to it.
- Thundering herd at :00 across many workspaces → batch size + `SKIP LOCKED` + backpressure counters; measured in Part 27.
- Should `scheduledFor` be a column for reporting? (Proposed: yes, nullable, indexed with workflow.)
- Manual run input vs trigger metadata shape (FR-23.9).

## Implementation Notes

- Put the evaluator next to `RunSweeper` (`src/execution/`), the schedule compiler in `src/engine/schedule/` (pure), and the publish hook next to the webhook-route hook.
- The occurrence ISO string must be canonical UTC with milliseconds (`toISOString()`), so retries compute the identical key.
