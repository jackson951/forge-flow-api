# 01 — Foundation and Infrastructure

**Status:** COMPLETE (2026-09-30) — evidence below; see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Give FlowForge a production-style NestJS foundation that later parts build on without rework: typed and validated configuration, PostgreSQL through Prisma, Redis, standard errors, correlation IDs, structured logs, health/readiness probes, versioned and documented HTTP API, security headers, graceful shutdown and a working test harness.

## Why This Part Exists

Every later part (auth, workflows, queues, webhooks, integrations) assumes these cross-cutting concerns exist and behave consistently. Retrofitting correlation IDs, error shapes or API versioning after dozens of endpoints exist is expensive and error-prone. Doing it first also means the application is runnable and verifiable from day one.

## Scope

- Project structure for one codebase with two entrypoints (API `src/main.ts`, worker `src/worker.ts`).
- Environment configuration and startup validation.
- Prisma client lifecycle and PostgreSQL connectivity.
- Redis client lifecycle and connectivity (separate from BullMQ's own connections).
- Docker Compose for local PostgreSQL and Redis.
- Global validation pipe, global exception filter, standard error envelope.
- Request correlation IDs propagated to logs, responses and error bodies.
- Structured JSON logging with secret redaction.
- Liveness and readiness endpoints.
- Swagger/OpenAPI (non-production only by default).
- URI API versioning (`/api/v1`).
- CORS allow-list, Helmet, removal of `X-Powered-By`.
- Graceful shutdown of HTTP server, Prisma and Redis.
- Base unit and e2e/integration Jest configuration.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-01.1 | The API starts with a single command in development (`npm run start:dev`) once Postgres and Redis are running. |
| FR-01.2 | Startup fails fast with a readable message listing every invalid or missing environment variable. |
| FR-01.3 | `GET /api/v1/health` returns `200` whenever the process is alive, without touching dependencies. |
| FR-01.4 | `GET /api/v1/health/ready` returns `200` only when PostgreSQL and Redis both respond within a timeout; otherwise `503` with per-dependency status. |
| FR-01.5 | Every response carries an `x-request-id` header. A caller-supplied, well-formed `x-request-id` is reused; otherwise one is generated. |
| FR-01.6 | Every error response uses one JSON envelope (see API Changes). |
| FR-01.7 | Swagger UI is served at `/api/docs` when `SWAGGER_ENABLED=true` (default: true outside production, false in production). |
| FR-01.8 | The process shuts down cleanly on `SIGTERM`/`SIGINT`: stops accepting connections, finishes in-flight requests, closes Prisma and Redis. |

## Technical Requirements

- **Configuration:** `@nestjs/config` + zod schema in `src/config/env.schema.ts`; access only through the typed `AppConfigService`. No `process.env` reads outside `src/config` (except Prisma CLI and test bootstrap).
- **Production guards:** in `NODE_ENV=production`, reject placeholder secrets (values starting with `change-me`) and require `CORS_ORIGINS` to be explicit.
- **Prisma:** a single global `PrismaService` (extends `PrismaClient`), connecting on module init and disconnecting on shutdown. Feature code injects `PrismaService`; no `new PrismaClient()` in application code.
- **Redis:** a global `RedisModule` exposing one `ioredis` client via an injection token (`REDIS_CLIENT`) for readiness checks and later for rate limiting/OAuth state. `maxRetriesPerRequest` kept low for request-path usage; client closed with `quit()` on shutdown.
- **Validation:** global `ValidationPipe` with `whitelist`, `forbidNonWhitelisted`, `transform`. Validation failures return `400` with field-level `details`.
- **Exception filter:** maps `HttpException`s to their status, Prisma `P2002` → `409`, `P2025` → `404`, anything else → `500` with a generic message. Stack traces only in server logs.
- **Correlation ID:** generated in the pino-http `genReqId` hook; incoming IDs accepted only if they match `^[A-Za-z0-9._-]{1,128}$` (prevents log injection). Available as `req.id` and included in log lines through nestjs-pino's async context.
- **Logging:** `nestjs-pino`; JSON in production, `pino-pretty` in development, quiet in tests. Redaction paths centralised in `src/common/utils/redact.ts`.
- **App setup shared by runtime and tests:** a single `configureApp(app)` function applies prefix, versioning, Helmet, CORS, shutdown hooks and Swagger so tests exercise exactly what production runs.
- **Versioning:** `VersioningType.URI`, default version `1`, global prefix `api` → `/api/v1/...`.
- **Timeouts:** readiness dependency checks time out after 2 seconds each so the probe itself cannot hang.

## API Changes

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/v1/health` | Public | Liveness: `{ "status": "ok", "timestamp": "..." }` |
| GET | `/api/v1/health/ready` | Public | Readiness: `{ "status": "ok" \| "error", "checks": { "database": {"status": "up", "latencyMs": 3}, "redis": {...} } }`, `200` or `503` |
| GET | `/api/docs` | Public (non-prod) | Swagger UI; JSON at `/api/docs-json` |

Standard error envelope (all non-2xx responses):

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Validation failed",
  "details": [{ "field": "email", "messages": ["email must be an email"] }],
  "requestId": "6f1c...",
  "path": "/api/v1/auth/register",
  "timestamp": "2026-09-30T12:00:00.000Z"
}
```

`details` is present only for validation errors.

## Database Changes

None beyond confirming that the existing Prisma schema and migrations apply cleanly. Domain modelling is Part 02.

## Security Requirements

- `.env` is git-ignored; `.env.example` contains only local-development placeholders.
- `X-Powered-By` absent from all responses; Helmet default headers present.
- CORS only reflects origins listed in `CORS_ORIGINS`; other origins receive no `Access-Control-Allow-Origin`.
- 5xx responses never include exception messages, stack traces, SQL or Prisma internals.
- Log redaction covers `authorization`, `cookie`, provider signature headers and password/token fields.
- Correlation IDs are length- and charset-restricted.
- Swagger disabled in production unless explicitly enabled.

## Testing Requirements

- Unit: env validation (valid, missing, placeholder secret in production), exception filter mapping (HttpException, validation, Prisma codes, unknown error), correlation-ID acceptance/rejection, readiness service up/down/timeout with mocked dependencies.
- E2E (real Postgres + Redis from Docker Compose): liveness 200, readiness 200 when both up, versioned path works and unversioned path 404s, validation error envelope, security headers present and `X-Powered-By` absent, CORS allowed vs disallowed origin, request-ID echo, Swagger reachable in development mode, `app.close()` closes Prisma and Redis.

## Deliverables

1. `src/config/*` — schema with production guards and tests.
2. `src/infrastructure/redis/redis.module.ts` (global `REDIS_CLIENT`), alongside the existing `infrastructure/prisma`, `infrastructure/queue` modules.
3. `src/app.setup.ts` — `configureApp()` used by `main.ts` and tests.
4. Updated exception filter with standard envelope and Prisma mapping.
5. Correlation-ID sanitising in logger setup.
6. Health module with real readiness checks.
7. Docker Compose for Postgres/Redis and a consistent `.env.example`.
8. Jest unit config, e2e config, and test helpers for creating the app.
9. README quick-start updated for `/api/v1`.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-01.1 | Application starts successfully against Compose Postgres/Redis | Manual `npm run start:dev` log + e2e boot |
| AC-01.2 | PostgreSQL connection works | Readiness `database.status = up` in e2e |
| AC-01.3 | Redis connection works | Readiness `redis.status = up` in e2e |
| AC-01.4 | Prisma migrations apply to the database | `npx prisma migrate deploy` / `migrate status` output |
| AC-01.5 | Invalid body is rejected with `400` and field details | E2E test using a validation probe DTO |
| AC-01.6 | Errors use the standard envelope incl. `requestId` | Unit + e2e |
| AC-01.7 | `GET /api/v1/health` → 200 | E2E |
| AC-01.8 | `GET /api/v1/health/ready` → 200 when up, 503 when a dependency is down | E2E (up) + unit (down/timeout) |
| AC-01.9 | Swagger served in development, disabled when `SWAGGER_ENABLED=false` | E2E |
| AC-01.10 | Shutdown closes HTTP, Prisma and Redis | E2E asserts Redis client status `end` after `app.close()`; manual SIGTERM log check |
| AC-01.11 | Startup fails on invalid configuration | Unit test of `validateEnv` |
| AC-01.12 | Helmet headers present, `X-Powered-By` absent, CORS allow-list enforced | E2E |
| AC-01.13 | Build, lint, typecheck, unit and e2e tests pass | Command output recorded below |
| AC-01.14 | No credentials committed | `git ls-files` contains no `.env`; `.env.example` holds placeholders only |

## Definition of Done

The common definition of done in [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md#definition-of-done) applies, plus: every acceptance criterion above has recorded evidence in the Implementation Evidence section.

## Out of Scope

- Authentication logic (Part 03). The existing global guard stays secure-by-default (non-public routes → 401).
- BullMQ job processing (Part 07). The queue module stays registered but unused.
- Production container orchestration and CI changes (Part 20).
- Distributed rate-limit storage (Part 18).

## Dependencies

None. This is the root of the dependency graph.

## Risks / Design Questions

- **Readiness scope:** readiness checks Postgres and Redis only. External providers (GitHub, Slack) must never be part of readiness — an outage there should not take pods out of rotation.
- **Health under versioning:** orchestrators prefer stable probe paths. Decision: keep health under `/api/v1` as specified; if a version 2 ships, health stays pinned to version 1 via `@Version('1')` rather than moving.
- **Windows signals:** `SIGTERM` handling is verified in the Linux container; on Windows dev machines `Ctrl+C` delivers `SIGINT`.

## Implementation Notes

- The scaffold already includes zod env validation, Helmet, `x-powered-by` removal, pino with redaction and Swagger. This part completes and verifies these rather than rewriting them.
- `ioredis` is already present transitively through BullMQ; it becomes a direct dependency.

## Implementation Evidence

Verified 2026-09-30 on Windows 11, Node 24.13, Docker 29.8 (Postgres 17 on host port 5433, Redis 7 on 127.0.0.1:6379). Base commit `88b2fb5` plus the Part 01 working-tree changes.

### What was implemented

| Area | Files |
| --- | --- |
| Config validation + production guards (placeholder/identical JWT secrets, wildcard CORS), `SWAGGER_ENABLED`, `silent` log level | `src/config/env.schema.ts`, `src/config/app-config.service.ts` |
| Shared HTTP setup (prefix, URI versioning `/api/v1`, Helmet, CORS allow-list exposing `x-request-id`, Swagger toggle, `x-powered-by` off) | `src/app.setup.ts`, `src/main.ts` |
| Global Redis client (`REDIS_CLIENT`, offline queue disabled, closes on shutdown and waits for socket `end`) | `src/infrastructure/redis/redis.module.ts` |
| Standard error envelope, validation `details`, Prisma P2002→409 / P2025→404, 5xx sanitised | `src/common/filters/all-exceptions.filter.ts`, `src/common/pipes/validation.pipe.ts` |
| Correlation-ID sanitising (`^[A-Za-z0-9._-]{1,128}$`), pino-pretty only in `development`, health probes excluded from access logs | `src/common/utils/request-id.ts`, `src/infrastructure/logger/logger.module.ts` |
| Readiness: Postgres `SELECT 1` + Redis `PING`, 2 s timeout each, 503 when down | `src/modules/health/*` |
| Shutdown log from both processes | `src/core/core.module.ts` |
| Compose: dev-safe defaults for `POSTGRES_*`/`DATABASE_URL_DOCKER` (previously blank), ports bound to 127.0.0.1; `.env.example` aligned (port 5433, all Compose variables) | `docker-compose.yml`, `.env.example` |
| Test config: `tsconfig.spec.json` (transpile-only ts-jest, ~2× faster, no deprecation warning), e2e setup file, `createTestApp()` helper using `configureApp` | `package.json`, `test/jest-e2e.json`, `test/setup-env.ts`, `test/support/create-app.ts` |

### Command results

| Command | Result |
| --- | --- |
| `npx prettier --check "src/**/*.ts" "test/**/*.ts"` | pass |
| `npm run lint` | pass, 0 problems |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm test` | 7 suites, 34 tests passed |
| `npm run test:e2e` | 1 suite, 14 tests passed (real Postgres + Redis) |
| `npx prisma validate` / `migrate status` | valid / up to date |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-01.1 | PASS | Built server (`node dist/main.js`) and production container both started and served requests; e2e boots the full `AppModule` |
| AC-01.2 | PASS | e2e `health/ready` → `database.status = up`; live server `{"database":{"status":"up","latencyMs":51}}` |
| AC-01.3 | PASS | Same, `redis.status = up` |
| AC-01.4 | PASS | `prisma migrate status` up to date on dev DB; Compose `postgres` service started on an **empty volume** (isolated `compose run`, port 5439) and `prisma migrate deploy` applied all migrations (14 tables); temporary container/volume removed |
| AC-01.5 | PASS | e2e: invalid register body → 400 with `details` for `email`, `password`, `name`, unknown `role`; unit tests for nested paths |
| AC-01.6 | PASS | Unit (7 filter cases incl. no leak of Prisma constraint names / error messages) + e2e (400/401/404 envelopes with `requestId`) |
| AC-01.7 | PASS | e2e + live: `GET /api/v1/health` → 200; `/api/health` → 404 |
| AC-01.8 | PASS | e2e 200 when up; unit: DB down, Redis down, hanging dependency times out; **live**: Redis container stopped → `503 {"redis":{"status":"down"}}` in 38 ms, liveness still 200, recovered to 200 ~1 s after restart |
| AC-01.9 | PASS | e2e `/api/docs-json` 200 in test env; e2e with Swagger disabled → 404; production container `/api/docs` → 404 |
| AC-01.10 | PASS | e2e: after `app.close()` Prisma `$disconnect` called and Redis status `end` (this test caught a real bug: `quit()` resolved before the socket closed — fixed). Production container `docker stop` (SIGTERM) → log `Graceful shutdown started (SIGTERM)`, exit code 0 in 3 s |
| AC-01.11 | PASS | Unit tests for `validateEnv`; production container with placeholder JWT secrets refuses to boot listing both variables |
| AC-01.12 | PASS | e2e: `nosniff`, `SAMEORIGIN`, HSTS, CSP present; `X-Powered-By` absent; allowed origin reflected with credentials; `https://evil.example.com` gets no `Access-Control-Allow-Origin` |
| AC-01.13 | PASS | Command results above |
| AC-01.14 | PASS | `git ls-files` contains no `.env`; `.env.example` holds local-dev placeholders only; containers were run with throwaway random secrets |

### Known limitations / follow-ups (not blocking)

- The local `flowforge-postgres` container on this machine was created outside Compose (`docker run`, volume `flowforge_postgres_data`), so `docker compose up postgres` conflicts on the container name. The Compose service itself is verified (see AC-01.4). To switch, remove the old container (data is in its volume) and run `docker compose up -d postgres`, or keep using it.
- The new e2e suite needs Postgres/Redis, so `.github/workflows/ci.yml` now starts both as service containers with throwaway env values and runs `prisma validate` and `migrate deploy` before e2e. **This workflow has not been run on GitHub yet** (nothing has been pushed), so it stays unverified until the first push. The rest of CI hardening is Part 20.
- The throttler still uses in-memory storage (Part 18).
