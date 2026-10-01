# 16 — Run History and Observability

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

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
