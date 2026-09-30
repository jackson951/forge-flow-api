# 20 — CI/CD and Containerization

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

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
