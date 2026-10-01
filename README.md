# FlowForge API

Backend for **FlowForge** — an integration & workflow automation platform. NestJS 11 · TypeScript · PostgreSQL/Prisma · Redis/BullMQ.

> Status: foundation, data model, authentication, workspace authorization, workflow management and publishing are implemented (see [docs/backend](docs/backend/00-BACKEND-ROADMAP.md)). Routes for later parts exist but return `501 Not Implemented`. Every non-`@Public()` route requires a bearer token, and every `/workspaces/:workspaceId/...` route requires membership (non-members get `404`).

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
| `npm test` / `test:cov` | Unit tests (no external services) |
| `npm run test:e2e` | E2E tests — needs `docker compose up -d postgres redis` and `.env` |
| `npm run prisma:migrate` / `prisma:studio` | Database |

## API surface (scope §12)

Paths below are relative to `/api/v1`. The backend roadmap and per-part specifications live in [docs/backend](docs/backend/00-BACKEND-ROADMAP.md).

| Route | Module |
| --- | --- |
| `/auth/*` (register, login, refresh, logout, logout-all, me) | auth |
| `/workspaces`, `/workspaces/:workspaceId` | workspaces |
| `/workspaces/:workspaceId/members` (+ `/:userId`) | workspaces |
| `/workspaces/:workspaceId/workflows` (+ `/draft`, `/validate`, `/publish`, `/versions`, `/versions/:version`, `/duplicate`, `/archive`, `/unarchive`) | workflows |
| `/node-types` | workflows |
| `/workspaces/:workspaceId/runs` (+ `/retry`, `/cancel`) | runs |
| `/workspaces/:workspaceId/integrations` (+ `/:provider/connect`) | integrations |
| `/integrations/providers`, `/integrations/:provider/callback` | integrations |
| `/workspaces/:workspaceId/dashboard` | dashboard |
| `/webhooks/:provider` | webhooks |
| `/health`, `/health/ready` | health |

See `docs/architecture.md` for the process split and folder map.
