# Architecture

One NestJS codebase, two entrypoints:

| Process | Entry | Module | Role |
| --- | --- | --- | --- |
| API | `src/main.ts` | `AppModule` | HTTP, auth, CRUD, webhook intake. Enqueues runs — never executes them. |
| Worker | `src/worker.ts` | `WorkerModule` | Consumes the `workflow-runs` BullMQ queue and executes workflows. |

Both import `CoreModule` (config, logging, Prisma, queue, crypto) so infrastructure is defined once.

```
Webhook → API /webhooks/:provider → verify → dedupe (WebhookDelivery unique) → enqueue
                                                                              ↓
                                          Worker → WorkflowExecutor → NodeHandlers → GitHub / Graph / Slack / AI

Schedule (Part 23): worker maintenance job "evaluate-schedules" (every SCHEDULE_TICK_INTERVAL_MS)
  → due WorkflowSchedule row (FOR UPDATE SKIP LOCKED) → QUEUED run, key schedule:<id>:<occurrence>
  → enqueue after commit → same worker / engine path as above

Generic webhook (Part 24): API /webhooks/hooks/:hookId → verify (token / basic / HMAC, IP list)
  → dedup (WebhookDelivery unique) → filter → QUEUED run → enqueue → configured fast reply

HTTP poll (Part 24): schedule tick (kind POLL) → http-polls queue → poll runner → egress guard
  → new items (seen window) → QUEUED run per item, key poll:<workflow>:<item> → enqueue
```

The worker's maintenance queue also runs the stale-run sweeper and retention. Every worker
upserts the same job schedulers, so each job runs once per interval however many workers exist.

## Folder map

```
src/
  config/          env schema (zod) + typed AppConfigService
  core/            CoreModule — infra shared by api + worker
  common/          decorators, guards, filters, DTOs, utils
  infrastructure/  prisma, queue (BullMQ), logger (pino), crypto
  engine/          workflow engine: contracts, registry, executor, conditions, processors
  modules/         feature modules — auth, users, workspaces, workflows, runs,
                   integrations (+ providers), webhooks, dashboard, health, ai
```
