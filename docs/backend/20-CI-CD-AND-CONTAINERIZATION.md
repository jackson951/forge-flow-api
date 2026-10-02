# 20 — CI/CD and Containerization

**Status:** COMPLETE (2026-10-02) — verified locally with Docker (evidence below); the green CI run link (AC-20.4) comes with this PR; see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Make builds, tests and container images repeatable: a production Dockerfile shared by API and worker, a development Compose stack, and GitHub Actions implementing the Part 19 quality gate.

## Why This Part Exists

"Works on my machine" is not evidence. Reviewers of a portfolio project (and future operators) need one command to run it and a green pipeline to trust it.

## Scope

Dockerfile, `.dockerignore`, Compose (dev infra + full profile with API, worker, one-shot migration), container health checks, GitHub Actions workflow(s), dependency and image scanning where practical.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-20.1 | `docker compose up -d postgres redis` starts dev infrastructure with health checks. |
| FR-20.2 | `docker compose --profile full up --build` runs migrate (one-shot) → API + worker, API healthy via `/api/v1/health/ready`. |
| FR-20.3 | One image, two commands: `node dist/main.js` (API) and `node dist/worker.js` (worker). |
| FR-20.4 | CI runs the Part 19 gate on pushes to `main` and all PRs, with Postgres and Redis service containers. |
| FR-20.5 | CI builds the Docker image (no push by default). |

## Technical Requirements

- Multi-stage build on `node:22-alpine` (or `-slim` if Prisma engines need glibc), `npm ci`, `prisma generate`, build, `npm prune --omit=dev`; runtime as non-root, `NODE_ENV=production`, no dev dependencies, no `.env`.
- Signal handling: run node directly (PID 1) with `--init` in Compose or `tini`, so SIGTERM reaches the app.
- Health checks: API container `wget -qO- http://localhost:3000/api/v1/health`; worker readiness via a lightweight heartbeat (e.g. Redis key or file) or process check.
- Compose env: `.env` for local; Compose-internal `DATABASE_URL` uses service names; `.env.example` documents all variables including `POSTGRES_*` used by Compose.
- Migrations: separate `migrate` service (`npx prisma migrate deploy`) that API/worker depend on (`service_completed_successfully`). Prisma CLI kept in the image or a dedicated migrate target.
- CI: Node 22, npm cache, concurrency cancel-in-progress, job timeouts, least-privilege `permissions: contents: read`, pinned action versions.
- Security checks: `npm audit --audit-level=high`; optional Trivy image scan (non-blocking initially, documented).

## API Changes

None.

## Database Changes

None (Compose init script creates `flowforge_test` database).

## Security Requirements

- No secrets in repository, images or CI logs; CI uses throwaway values for JWT secrets/encryption keys generated per run.
- Image runs as non-root; no build tools in runtime stage.

## Testing Requirements

- CI pipeline itself is the test; evidence = link to a green run.
- Local: `docker compose --profile full up --build` then readiness 200 and a manual-trigger run completes.
- `docker stop` on API and worker exits within the grace period with clean shutdown logs.

## Deliverables

Updated `Dockerfile`, `docker-compose.yml`, `docker/postgres/init.sql`, `.github/workflows/ci.yml`, optional `dependabot.yml`, README run instructions.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-20.1 | Dev infra starts healthy | `docker compose ps` output |
| AC-20.2 | Full stack starts, migrations apply, API ready | Manual run evidence |
| AC-20.3 | API and worker containers from one image | Compose file + running containers |
| AC-20.4 | CI runs lint, typecheck, unit, integration, e2e, build, prisma validate, audit | Green CI run link |
| AC-20.5 | Graceful container stop | `docker stop` logs |
| AC-20.6 | No secrets committed | Repo scan (gitleaks or grep) in CI |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Cloud deployment, Kubernetes manifests, image publishing to a registry, CD to an environment (documented as future work).

## Dependencies

Parts 01, 19 (gate definition); can be advanced incrementally from Part 01.

## Risks / Design Questions

- Alpine + Prisma engines: verify `binaryTargets` for `linux-musl-openssl-3.0.x`.

## Implementation Notes

The scaffold has a Dockerfile, Compose file with `full` profile and a CI workflow (lint/typecheck/unit/e2e/build) but no migrate step, no DB services in CI, and a worker command inconsistent with the Dockerfile default. `.env.example` lacks `POSTGRES_*` and `DATABASE_URL_DOCKER` that Compose references.

## As implemented

### Image (`Dockerfile`)

| Stage | Purpose |
| --- | --- |
| `deps` | `npm ci` (all dependencies, Prisma engines downloaded) |
| `build` | `prisma generate` (selects the `linux-musl-openssl-3.0.x` engine automatically — no `binaryTargets` needed because generation runs in the container) + `nest build` |
| `prod-deps` | Clean `npm ci --omit=dev --omit=optional --ignore-scripts` |
| `migrate` | Prisma CLI + schema + migrations; `CMD npx prisma migrate deploy`; non-root |
| `runtime` | `node:22-alpine`, `NODE_ENV=production`, production `node_modules` + the generated `.prisma` client + `dist`; non-root user `app`; `CMD node dist/main.js` (worker: `node dist/worker.js`) |

**Why `prod-deps` instead of `npm prune --omit=dev`:** `@prisma/client` declares the Prisma CLI and TypeScript as optional peers, so the lockfile marks them `devOptional` and both `npm prune --omit=dev` and `npm ci --omit=dev` keep them (≈ 120 MB, plus `effect` etc.). `--omit=optional` removes them; optional native accelerators such as `msgpackr-extract` fall back to pure JS. Result: image 724 MB → **491 MB**, `node_modules` 362 MB → 190 MB; `argon2`, `bullmq` and the Prisma client verified to load.

`.dockerignore` excludes `.env*` (except `.env.example`), `*.pem`, `*.key`, `.git`, `.github`, `test`, `docs`, `coverage`, `node_modules`, `dist`.

### Compose (`docker-compose.yml`)

- `postgres`, `redis`: health checks, localhost-only ports; `docker/postgres/init.sql` creates `flowforge_test` on a fresh volume.
- `full` profile: `migrate` (one-shot) → `api` and `worker` (`depends_on: service_completed_successfully`), one shared image definition (`x-app` anchor, `image: flowforge-api:local`), `init: true` (tini as PID 1), `stop_grace_period: 30s`, `env_file: .env` (optional), service-name `DATABASE_URL`/`REDIS_HOST`.
- Health checks: API `wget -qO- http://127.0.0.1:3000/api/v1/health/ready`; worker: `WORKER_HEARTBEAT_FILE` younger than one minute (`WorkerHeartbeat` rewrites it every 15 s while the BullMQ consumer is running; disabled when unset).
- `AI_PROVIDER_DOCKER` (default empty) overrides `AI_PROVIDER` inside the stack, since the fake provider is refused in production mode.

### CI (`.github/workflows/ci.yml`)

| Job | Content |
| --- | --- |
| `build-test` | The Part 19 gate, with Postgres/Redis service containers; **JWT secrets generated per run** with `openssl rand` and masked (no fixed values in the file); coverage artifact |
| `docker` | Builds `runtime` and `migrate` images (no push); asserts non-root, no TypeScript, no `.env` in the image; Trivy scan of HIGH/CRITICAL, **non-blocking** (`exit-code: 0`) until a baseline is reviewed |
| `secret-scan` | gitleaks v8.21.2 over the full git history, blocking |

All jobs: `permissions: contents: read`, timeouts, `concurrency` with cancel-in-progress. Actions are pinned to major versions (`checkout@v4`, `setup-node@v4`, `upload-artifact@v4`) and Trivy to `0.28.0`; Dependabot keeps them current (Part 18). Pinning to commit SHAs is a possible further step.

## Implementation Evidence

Verified 2026-10-02 on branch `feat/part-20-ci-cd` (stacked on `feat/part-19-quality-gate`). The full stack was run as a separate Compose project (`-p flowforge-verify` with an override for container names, ports and volumes) so the developer's running `flowforge-postgres`/`flowforge-redis` were not touched; it was removed afterwards.

| ID | Result | Evidence |
| --- | --- | --- |
| AC-20.1 | PASS | `postgres` and `redis` reached `(healthy)`; `flowforge_test` created by the init script (`SELECT datname …` → `flowforge`, `flowforge_test`) |
| AC-20.2 | PASS | `up --profile full`: `migrate` "3 migrations found … All migrations have been successfully applied", exited 0; `api` and `worker` `(healthy)`; `GET /api/v1/health/ready` → `{"status":"ok", database up, redis up}`; register → workspace → workflow (`manual.trigger` → `util.log`) → publish → run: QUEUED → SUCCEEDED in 158 ms, step output `hello containers`; worker container logged Run started / 2× Step succeeded / Run finished |
| AC-20.3 | PASS | `api` and `worker` both run image `flowforge-api:local` with commands `node dist/main.js` / `node dist/worker.js`; uid 100 (`app`), `init=true` |
| AC-20.4 | PENDING CI | Workflow implements lint, typecheck, unit (+thresholds), integration, e2e, build, prisma validate/migrate, audit, image build, secret scan; all steps pass locally (`npm run test:all` 862+ tests, build, audit 0). Green run link to be recorded from the PR |
| AC-20.5 | PASS | `docker stop` of api + worker took 1.23 s (grace 30 s); both logged `Graceful shutdown started (SIGTERM)`; exit 143 = terminated by SIGTERM after Nest's shutdown hooks (Nest re-raises the signal), not 137 (SIGKILL) |
| AC-20.6 | PASS | gitleaks v8.21.2 over the full history: "27 commits scanned … no leaks found" (test credentials are assembled at runtime, Part 17); CI job added |

### Found and fixed during this part

- **Dev dependencies shipped in the runtime image** (TypeScript, Prisma CLI, engines, `effect`: ≈ 170 MB) because `npm prune --omit=dev` keeps optional peers — fixed with a clean `--omit=optional` install stage.
- **No way to run migrations from the image** (the CLI was pruned) — new `migrate` target and Compose service.
- **No signal forwarding** (Node as PID 1 without init) and **no health checks** — `init: true`, API readiness check, worker heartbeat.
- **Fixed JWT secrets in the CI file** — now random per run.
- `WORKER_HEARTBEAT_FILE=` (empty, as in `.env.example`) would have failed config validation — empty now means unset.

### Notes

- Nest logs a `LegacyRouteConverter` warning ("Unsupported route path /api/*") at startup; it comes from Nest's own conversion of the global-prefix middleware path and is harmless.
- On Windows, host ports in Hyper-V's excluded ranges cannot be bound (seen with 55433); the default ports are unaffected.
- Out of scope (future): registry publishing, image signing, deployment.
