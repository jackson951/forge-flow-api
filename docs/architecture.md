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
```

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
