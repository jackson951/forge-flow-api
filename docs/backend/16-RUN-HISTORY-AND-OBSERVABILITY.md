# 16 — Run History and Observability

**Status:** COMPLETE (2026-10-02) — evidence below; see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Give users and operators the APIs and logs needed to answer "what happened to this run and why", correlating a request from the API through the queue to each worker step.

## Why This Part Exists

Automation that fails silently is worse than none. Diagnosability is also how the reliability claims of Part 15 are demonstrated.

## Scope

Run list/detail/steps APIs with filters and pagination, manual retry and cancellation endpoints, error categories, structured log fields across API and worker, a workspace dashboard summary.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-16.1 | List runs in a workspace, newest first, cursor pagination (limit ≤ 100), filters: `workflowId`, `status`, `from`, `to` (created time), `triggerSource`. |
| FR-16.2 | Run detail: status, version number, trigger source, sanitised trigger input, timestamps, duration, attempt count, error category/message, `retryOfRunId`, correlation ID. |
| FR-16.3 | Step list for a run ordered by sequence with status, attempts, duration, sanitised input/output, error category/message, `externalRef`. |
| FR-16.4 | Retry (Part 15 semantics) and cancel: cancel allowed for `QUEUED` (removes job, sets `CANCELLED`) and `RUNNING` (sets `cancelRequestedAt`; engine stops before next step). Terminal runs → `409`. |
| FR-16.5 | Dashboard: counts by status over last 24 h/7 d, top failing workflows, recent failures. |
| FR-16.6 | Run history survives workflow archive and new publishes. |

### Error categories

`VALIDATION`, `AUTHORIZATION`, `PROVIDER_AUTH`, `PROVIDER_RATE_LIMIT`, `PROVIDER_TIMEOUT`, `TRANSIENT_INFRASTRUCTURE`, `PERMANENT_PROVIDER_ERROR`, `UNCERTAIN_OUTCOME`, `CANCELLED`, `INTERNAL`. Each maps to `retryable: boolean` in one table in code.

## Technical Requirements

- Log context fields (pino child loggers): `correlationId`, `workspaceId`, `workflowId`, `workflowRunId`, `workflowVersionId`, `stepRunId`, `nodeKey`, `jobId`, `attempt`, `provider`, `durationMs`, `errorCategory`.
- `correlationId` from the originating HTTP request (or webhook delivery) stored on `WorkflowRun` and bound to worker logs.
- One log line per step start/finish and per run finish (info), failures at warn/error; no payload bodies in logs.
- Queries use the (`workspaceId`, `createdAt`) / (`workflowId`, `createdAt`) indexes; no N+1 (steps fetched in one query).
- Cursor = opaque base64 of (`createdAt`, `id`).

## API Changes

Base `/api/v1/workspaces/:workspaceId`

| Method | Path | Min role |
| --- | --- | --- |
| GET | `/runs` | MEMBER |
| GET | `/runs/:runId` | MEMBER |
| GET | `/runs/:runId/steps` | MEMBER |
| POST | `/runs/:runId/retry` | ADMIN |
| POST | `/runs/:runId/cancel` | ADMIN |
| GET | `/dashboard` | MEMBER |

## Database Changes

`WorkflowRun.correlationId`, `cancelRequestedAt`, `lastErrorCategory` if not already present; indexes confirmed.

## Security Requirements

- Tenant scoping + isolation-suite coverage for all routes.
- Sanitised input/output only; redaction verified by test fixtures containing token-like values.
- Error messages stored are sanitised (no provider response bodies containing secrets).

## Testing Requirements

Integration: filters individually and combined; pagination stability (no duplicates/misses across pages while new runs are inserted); detail + steps; retry/cancel state rules; tenant isolation; a failed run exposes category and message; log capture test asserting a single correlation ID appears in API log, enqueue log and worker step logs, and no secret fixture values appear in any log line.

## Deliverables

Runs module (controller/service/DTOs), dashboard service, error-category catalogue, logging context helpers for worker, tests, troubleshooting notes.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-16.1 | Failed workflow diagnosable from API (failed step, category, message) | Integration |
| AC-16.2 | Logs correlate API → queue → worker | Log capture test |
| AC-16.3 | Run history remains after archive and republish | Integration |
| AC-16.4 | Secrets/tokens not logged | Log capture test with canary values |
| AC-16.5 | Filters and pagination correct; limit capped at 100 | Integration |
| AC-16.6 | Cancel/retry obey state rules | Integration |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Metrics backend (Prometheus), tracing (OpenTelemetry) — listed as future improvements; log shipping.

## Dependencies

Parts 07, 08, 15.

## Risks / Design Questions

- Large histories: retention policy and archival handled in Part 21.

## Implementation Notes

Replaces scaffold `RunsService` and `DashboardService` stubs (routes already under the workspace prefix since Part 04). The engine already honours `cancelRequestedAt` (Part 08); this part adds the endpoint.

## API reference (as implemented)

Base `/api/v1/workspaces/:workspaceId`. Reads: MEMBER; retry/cancel: ADMIN.

| Endpoint | Response |
| --- | --- |
| `GET /runs?workflowId&status&triggerSource&from&to&limit&cursor` | `{ items: RunSummary[], nextCursor }`, newest first; `limit` 1–100 (default 20); `from` inclusive, `to` exclusive (created time); `cursor` = opaque base64url of `(createdAt, id)` |
| `GET /runs/:id` | RunSummary + `workflowVersionId`, redacted `triggerInput`, `correlationId`, `webhookDeliveryId`, `queuedAt`, `cancelRequestedAt`, `retriedByRunIds`, `failedStep { nodeKey, nodeType, error }` |
| `GET /runs/:id/steps` | Steps by sequence: status, attempts, duration, timestamps, redacted `input`/`output`, `error`, `externalRef` |
| `POST /runs/:id/retry` | Part 15 (`202 { runId, status, retryOfRunId, reusedSteps }`) |
| `POST /runs/:id/cancel` | `200 { runId, status, cancelRequested }`; QUEUED → CANCELLED now (job removed); RUNNING → stops before the next step; finished → 409 `{ details: { status } }` |
| `GET /dashboard` | `{ runs: { last24h, last7d } (counts per status + total), topFailingWorkflows (7 d, top 5), recentFailures (last 10) }` |

RunSummary: `id, workflowId, workflowName, version, status, triggerSource, attemptCount, error, retryOfRunId, createdAt, startedAt, completedAt, durationMs`. `error` = `{ category, message, retryable, description }` from the catalogue (`src/engine/error-categories.ts`) or `null`.

## Logging (as implemented)

| Log line (level) | Process | Context fields |
| --- | --- | --- |
| request completed / errored (info/warn, pino-http) | API | `req.id` = correlation id (`x-request-id`, echoed in the response) |
| `Run queued`, `Run retry queued` (info) | API | `runId`, `workflowId`, `workflowVersionId` |
| **`Run enqueued`** (info, new) | API / sweeper | `runId`, `jobId`, `correlationId`, `workspaceId`, `workflowId` (webhooks: `provider`, `deliveryId`; sweeper: `reason`) |
| `Run started` / `Run finished` / `Run failed` / `Run attempt failed; retry scheduled` | worker | `runId`, `jobId`, `attempt`, `workspaceId`, **`workflowId`**, `workflowVersionId`, `correlationId`, `durationMs`, `errorCategory` |
| **`Step started`** (new), `Step succeeded`, `Step failed` (warn), handler logs | worker | all run fields above (now bound to every engine line) + `nodeKey`, `nodeType`, `stepAttempt`, `durationMs`, `errorCategory`, `retryable` |

No payload bodies are logged; every log object passes the Part 17 redactor. `stepRunId` is not logged (runId + nodeKey identify a step uniquely).

### Troubleshooting a failed run

1. `GET /runs/:id` → `error` (category, message, whether it would be retried) and `failedStep`.
2. `GET /runs/:id/steps` → which step failed after how many attempts, its stored input/output, `externalRef` of side effects already done.
3. `UNCERTAIN_OUTCOME` → check the provider (e.g. Slack channel) before `POST /runs/:id/retry` with `acknowledgeUncertainOutcome: true`; add `resumeFromFailedStep: true` to skip completed steps.
4. Logs: filter by the run's `correlationId` to see the original request, the enqueue and every worker line across processes.

## Implementation Evidence

Verified 2026-10-02 on branch `feat/part-16-run-history` (from `main` at `58a38e0`).

### What was implemented

| Item | Location |
| --- | --- |
| Error category catalogue (retryable + description per category) | `src/engine/error-categories.ts` |
| Run list (keyset cursor, filters), detail (failed step, retries, redacted input), steps, cancel | `src/modules/runs/runs.service.ts`, `runs.controller.ts`, `dto/list-runs-query.dto.ts` |
| Dashboard summary | `src/modules/dashboard/dashboard.service.ts` |
| Run-level log context on every engine line; `Step started`; `Run enqueued` with correlation context | `execution-engine.ts`, `run-worker.service.ts`, `run-queue.service.ts`, `run-dispatcher.service.ts`, `webhook-intake.service.ts` |
| Cancellation races closed: a run whose retry is due after a cancel request is finished as CANCELLED instead of re-queued; a QUEUED run with a cancel request is cancelled when a worker sees it | `run-worker.service.ts`, `PrismaRunStore.cancelIfRequested` |
| Tenant isolation suite attacks `/runs/:id…` with another workspace's run, and its snapshot includes runs | `test/integration/tenant-isolation.int-spec.ts` |

### Command results

| Command | Result |
| --- | --- |
| prettier check, lint (0 warnings), typecheck, build | pass |
| `npm test` | 530 passed (incl. `error-categories.spec.ts`) |
| `npm run test:e2e` | 16 passed |
| `npm run test:int` | 270 passed (14 in `test/integration/runs.int-spec.ts`) |

### Acceptance criteria

| ID | Result | Evidence (`runs.int-spec.ts` unless noted) |
| --- | --- | --- |
| AC-16.1 | PASS | Failed run detail: status, version, attempts, duration, correlation id, `error` {category, message, retryable, description}, `failedStep`; steps in order (`start`, `echo`, `fail` FAILED, `never` SKIPPED) with attempts, duration, error |
| AC-16.2 | PASS | A request with `x-request-id: corr-…`: header echoed (the API request log id), stored on the run, and present on `Run enqueued`, `Run started`, `Step started`, `Step succeeded`, `Run finished` together with workspace, workflow, version, job and attempt |
| AC-16.3 | PASS | After republishing (v2) and archiving: all v1 runs still listed with `version: 1`, the v2 run with `version: 2`; detail still readable |
| AC-16.4 | PASS | Manual input with a credential key, a Slack-shaped and a GitHub-shaped token: detail/steps responses show `[REDACTED]`; none of the canaries appears in any captured log call |
| AC-16.5 | PASS | Workflow, status, trigger source, from/to windows (exclusive `to`), combinations; `limit` 101 → 400, 100 → 200; bad cursor/status/date → 400; paging with inserts between pages → no duplicates, no misses, newer runs not on later pages; five runs in the same millisecond page correctly (id tie-break) |
| AC-16.6 | PASS | QUEUED cancel → CANCELLED, job removed, a late worker leaves it cancelled, audited; RUNNING cancel → `{ status: RUNNING, cancelRequested }`, then CANCELLED with the next step SKIPPED; finished → 409; MEMBER → 403; unknown → 404; retry of SUCCEEDED → 409, of FAILED → 202 and shown in `retriedByRunIds` and `triggerSource=RETRY` filter |

Also: dashboard counts per status for 24 h / 7 d (older runs excluded), top failing workflow, recent failures with error details; tenant isolation suite covers every new route (non-member 404, no token 401, foreign run id ≡ unknown id, nothing changed).

**Mutation checks** (each made tests fail, then reverted): run lookup without workspace scope (isolation suite); no redaction of trigger input on read; no run context on engine logs; cursor without the id tie-break (only caught after adding the same-millisecond test — the first version of the pagination test could not detect it).

### Notes

- Trigger input is stored as received because later steps need it; redaction happens when it is read through the API.
- `resumeFromFailedStep` and step outputs use sanitised data (Part 15 note).
- Metrics/tracing remain out of scope (future: Prometheus, OpenTelemetry).
