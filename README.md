# FlowForge API

Backend for **FlowForge** — an integration & workflow automation platform. NestJS 11 · TypeScript · PostgreSQL/Prisma · Redis/BullMQ.

> Scaffold stage: structure, wiring and contracts are in place; business logic is not. Unimplemented endpoints return `501 Not Implemented`, and every non-`@Public()` route returns `401` until auth is built (secure by default).

## Quick start

```bash
cp .env.example .env            # already present in the scaffold
docker compose up -d postgres redis
npm install
npx prisma migrate dev --name init
npm run start:dev               # API  → http://localhost:3000/api
npm run worker:dev              # worker (second terminal)
```

Swagger (non-production): http://localhost:3000/api/docs · Health: `GET /api/health`, `GET /api/health/ready`

Full stack in containers: `docker compose --profile full up --build`

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile to `dist/` (API → `dist/main.js`, worker → `dist/worker.js`) |
| `npm run start:dev` / `worker:dev` | Watch mode |
| `npm run lint` / `typecheck` | ESLint / `tsc --noEmit` |
| `npm test` / `test:e2e` / `test:cov` | Jest |
| `npm run prisma:migrate` / `prisma:studio` | Database |

## API surface (scope §12)

| Route | Module |
| --- | --- |
| `/api/auth/*` | auth |
| `/api/workspaces` | workspaces |
| `/api/workflows` (+ `/draft`, `/validate`, `/publish`, `/versions`, `/duplicate`, `/archive`) | workflows |
| `/api/runs` (+ `/retry`, `/cancel`) | runs |
| `/api/integrations` (+ `/:provider/connect`, `/:provider/callback`) | integrations |
| `/api/webhooks/:provider` | webhooks |
| `/api/dashboard` | dashboard |
| `/api/health` | health |

See `docs/architecture.md` for the process split and folder map.
