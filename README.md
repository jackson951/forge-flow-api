# FlowForge API

Backend for **FlowForge** — an integration & workflow automation platform. NestJS 11 · TypeScript · PostgreSQL/Prisma · Redis/BullMQ.

> Status: foundation, data model, authentication, workspace authorization, workflow management, publishing, the run queue/worker, the execution engine with conditions and data mapping, the webhook platform and the GitHub integration are implemented (see [docs/backend](docs/backend/00-BACKEND-ROADMAP.md)). Routes for later parts exist but return `501 Not Implemented`. Every non-`@Public()` route requires a bearer token, and every `/workspaces/:workspaceId/...` route requires membership (non-members get `404`).

## Quick start

```bash
cp .env.example .env            # local-development values only
docker compose up -d postgres redis
npm install
npx prisma migrate deploy
npm run start:dev               # API  → http://localhost:3000/api/v1
npm run worker:dev              # worker (second terminal)
```

Swagger (when `SWAGGER_ENABLED`, default outside production): http://localhost:3000/api/docs · Liveness: `GET /api/v1/health` · Readiness (Postgres + Redis, 503 if either is down): `GET /api/v1/health/ready`

All endpoints are versioned under `/api/v1`. Errors use one envelope: `{ statusCode, error, message, details?, requestId, path, timestamp }`; every response carries an `x-request-id` header.

Full stack in containers: `docker compose --profile full up --build`

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile to `dist/` (API → `dist/main.js`, worker → `dist/worker.js`) |
| `npm run start:dev` / `worker:dev` | Watch mode |
| `npm run lint` / `typecheck` | ESLint / `tsc --noEmit` |
| `npm test` / `test:cov` | Unit tests (no external services); `test:cov` enforces per-area coverage |
| `npm run test:int` / `test:e2e` | Integration / E2E tests (need Postgres + Redis) |
| `npm run test:all` | Every suite once, merged coverage, global coverage floor (what CI runs) |
| `npm run prisma:migrate` / `prisma:studio` | Database |

## Testing

| Suite | Location | Needs | Command |
| --- | --- | --- | --- |
| Unit | `src/**/*.spec.ts` | nothing (outbound HTTP is blocked) | `npm test` |
| Integration | `test/integration/*.int-spec.ts` | Postgres + Redis | `npm run test:int` |
| E2E | `test/e2e/*.e2e-spec.ts` | Postgres + Redis | `npm run test:e2e` |

1. `docker compose up -d postgres redis` (or point `DATABASE_URL` / `REDIS_HOST` at running servers). Without them the integration/E2E run stops with an explanation — tests never skip silently.
2. Integration and E2E tests use a separate database, `<your database>_test`, migrated automatically (`prisma migrate deploy`) and emptied by each test file; your development data is never touched. Each test file uses its own Redis key prefix (`ff-test-*`), removed afterwards.
3. Provider APIs (GitHub, Slack, Microsoft, the AI model) are never called: tests use in-process fakes (`test/support/fake-*.ts`), the fake AI provider, and any `fetch` to a non-local host fails.

**Writing tests:** factories in `test/support/factories.ts`, `registerUser`/`bearer` in `auth.ts`, `createTestApp` / `createTestWorker` (real API and worker, in-process), `waitFor` instead of sleeps, `captureLogs` + `expectNoSecrets` (`canaries.ts`) to prove secrets never reach logs or responses, test node types (`test.wait`, `test.fail`, `test.sideEffect`, …) in `test-node-types.ts`.

**Coverage:** unit thresholds — engine, expressions, validation and crypto ≥ 90 % lines (`jest.config.json`); whole-system floor ≥ 70 % lines/statements over all suites together (`test/jest-all.json`). Reports in `coverage/`.

**CI quality gate** (`.github/workflows/ci.yml`, all must pass): install → Prisma validate + migrate on a fresh database → format, lint, typecheck → unit tests + thresholds → all suites + coverage floor → build → `npm audit --audit-level=high`.

## API surface (scope §12)

Paths below are relative to `/api/v1`. The backend roadmap and per-part specifications live in [docs/backend](docs/backend/00-BACKEND-ROADMAP.md).

| Route | Module |
| --- | --- |
| `/auth/*` (register, login, refresh, logout, logout-all, me) | auth |
| `/workspaces`, `/workspaces/:workspaceId` | workspaces |
| `/workspaces/:workspaceId/members` (+ `/:userId`) | workspaces |
| `/workspaces/:workspaceId/workflows` (+ `/draft`, `/validate`, `/publish`, `/versions`, `/versions/:version`, `/duplicate`, `/archive`, `/unarchive`) | workflows |
| `/node-types` | workflows |
| `/workspaces/:workspaceId/workflows/:workflowId/runs` (start a manual run; optional `Idempotency-Key`) | runs |
| `/workspaces/:workspaceId/runs` (+ `/retry`, `/cancel`) | runs |
| `/workspaces/:workspaceId/integrations` (+ `/:provider/connect`) | integrations |
| `/integrations/providers`, `/integrations/:provider/callback` | integrations |
| `/workspaces/:workspaceId/dashboard` | dashboard |
| `/webhooks/:provider` (`github`, `test` in non-production) | webhooks |
| `/workspaces/:workspaceId/integrations/:connectionId/github/repositories` | integrations |
| `/health`, `/health/ready` | health |

See `docs/architecture.md` for the process split and folder map.
