# 19 — Testing and Quality Gate

**Status:** COMPLETE (2026-10-02) — evidence below; one documented deviation (global coverage floor measured over all suites, see AC-19.5); CI history for AC-19.6 accrues from this PR on; see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Consolidate the test suites built in each part into a coherent, fast, reliable pyramid with an end-to-end journey test and CI quality gates that block regressions.

## Why This Part Exists

Each part adds tests locally; this part fills gaps, removes flakiness, standardises helpers and defines the gate a change must pass.

## Scope

Test layout and tooling, shared fixtures/factories, test database lifecycle, coverage of the listed areas, failure-path tests, E2E journey, coverage thresholds, CI gate definition.

## Functional Requirements

### Layout

| Suite | Location | Runs against | Command |
| --- | --- | --- | --- |
| Unit | `src/**/*.spec.ts` | nothing external | `npm test` |
| Integration | `test/integration/**/*.int-spec.ts` | Postgres + Redis (Compose or CI services), mocked providers | `npm run test:int` |
| E2E | `test/e2e/**/*.e2e-spec.ts` | API + worker in-process, Postgres, Redis, mocked providers | `npm run test:e2e` |

### Required coverage

- **Unit:** graph validation, condition evaluation, data resolver, execution transitions, retry classification, node handlers, encryption, redaction, config validation.
- **Integration:** authentication, authorization, workspace isolation, workflow CRUD, publishing, webhook validation, idempotency (Part 15 scenarios), persistence constraints, run history.
- **E2E journey:** register → login → create workspace → create workflow → save draft (trigger `test.event` webhook → condition → `util.log`) → publish → send signed test webhook → run queued → worker executes → inspect run and steps (SUCCEEDED, correct branch).
- **Failure paths in E2E:** invalid signature; duplicate delivery; failing node → run FAILED with category; unauthorised access to another workspace's run.

## Technical Requirements

- Test DB: separate database `flowforge_test` (created by Compose init script); migrations applied once per test run (`prisma migrate deploy`), tables truncated between test files (`TRUNCATE … CASCADE` helper, excluding `_prisma_migrations`).
- Redis: dedicated DB index for tests; queues obliterated between files.
- Integration and E2E run with `--runInBand` to avoid shared-state races.
- Outbound HTTP blocked by default (msw/nock `disableNetConnect`), explicit mocks per test.
- Factories for users/workspaces/workflows; auth helper returning bearer headers.
- `ts-jest` with `isolatedModules` to keep suites fast.
- No sleeps: queue tests wait on events/polling with timeout helpers.
- Coverage thresholds (unit): engine, expressions, validation, crypto ≥ 90% lines; global ≥ 70%.

## API Changes

None.

## Database Changes

Test database setup only.

## Security Requirements

Tests use canary secrets and assert absence from responses/logs (shared helper). No real provider credentials in CI.

## Testing Requirements

This part's own check: run full suites 3× consecutively in CI without flakes.

## Deliverables

Jest configs (unit/int/e2e), test helpers (`test/support/`), E2E journey, coverage thresholds, CI gate definition (below), testing guide in README.

### CI quality gate (must all pass to merge)

1. `npm ci`
2. `prisma validate` and `prisma migrate deploy` on a fresh database
3. format check, lint (zero errors), typecheck
4. unit tests + coverage thresholds
5. integration tests
6. E2E tests
7. build
8. `npm audit --audit-level=high`
9. Docker image build (Part 20)

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-19.1 | All required unit areas have tests | Coverage report + checklist |
| AC-19.2 | All required integration areas have tests | Checklist linking files |
| AC-19.3 | E2E journey passes | CI |
| AC-19.4 | Failure-path E2E tests pass | CI |
| AC-19.5 | Coverage thresholds enforced | Jest config fails below threshold |
| AC-19.6 | Suites stable (3 consecutive green runs) | CI history |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Load testing (Part 21), contract tests with real providers, mutation testing.

## Dependencies

Parts 01–16 (consolidation), runs continuously from Part 01.

## Risks / Design Questions

- Integration tests need Docker locally; documented, with a clear skip message if services are unavailable (never silently passing).

## Implementation Notes

Part 01 establishes the unit/e2e configs; this part adds the integration config and helpers.

## As implemented

### Suites and configs

| Suite | Config | Location | Command |
| --- | --- | --- | --- |
| Unit | `jest.config.json` | `src/**/*.spec.ts` | `npm test`, `npm run test:cov` (thresholds) |
| Integration | `test/jest-int.json` | `test/integration/*.int-spec.ts` | `npm run test:int` |
| E2E | `test/jest-e2e.json` | `test/e2e/*.e2e-spec.ts` | `npm run test:e2e` |
| All (merged coverage) | `test/jest-all.json` (Jest projects) | all of the above | `npm run test:all` |

- All configs use the repository root as `rootDir` (`roots` select the tests), so every suite collects coverage from `src/` and the combined run merges it.
- Integration and E2E: run in band; a shared global setup checks Redis and runs `prisma migrate deploy` against the isolated `<db>_test` database and **fails with instructions** if Postgres or Redis is unavailable (never skips); `truncateAll` per file; a unique Redis key prefix per file (`ff-test-*`) instead of a dedicated Redis DB index, removed by the global teardown; 30 s per-test timeout via `setupFilesAfterEnv` (works in project mode, unlike `testTimeout`).
- E2E moved from `test/app.e2e-spec.ts` to `test/e2e/` and now uses the isolated test database (before, it used the `.env` database).
- `ts-jest` transpiles only (`isolatedModules` in `tsconfig.spec.json`); type-checking of tests is a separate gate step (`tsc -p tsconfig.spec.json`).
- Outbound HTTP to non-local hosts fails in every suite (`test/support/block-external-http.ts`); providers are in-process fakes.
- Shared helpers: `captureLogs` / `expectNoSecrets` (`test/support/canaries.ts`, replacing four copies of the same spy code), factories, auth helpers, `createTestApp` / `createTestWorker`, `waitFor` (no sleeps for queue progress), test node types, fake GitHub/Slack/Microsoft servers.

### Coverage

| Scope | Threshold | Actual (2026-10-02) |
| --- | --- | --- |
| Unit, `src/engine/` | ≥ 90 % lines | 93.5 % (execution 90.4 %, catalog/definition/validation 100 %) |
| Unit, `src/engine/expressions/` | ≥ 90 % | 92.4 % |
| Unit, `src/engine/validation/` | ≥ 90 % | 100 % |
| Unit, `src/infrastructure/crypto/` | ≥ 90 % | 98.5 % |
| All suites together, global | ≥ 70 % lines and statements | **97.3 % lines, 96.8 % statements** |

Module classes and the engine's in-memory test store are excluded from unit coverage (wiring/test code).

### CI quality gate (`.github/workflows/ci.yml`)

1. `npm ci` → 2. `prisma generate`, `validate`, `migrate deploy` on the fresh CI database → 3. prettier check, lint, typecheck (app and tests) → 4. `npm run test:cov` (unit + per-area thresholds) → 5–6. `npm run test:all` (unit, integration, E2E + global floor) → 7. build → 8. `npm audit --audit-level=high`; the coverage report is uploaded as an artifact. Step 9 (Docker image build) is added in Part 20.

## Implementation Evidence

Verified 2026-10-02 on branch `feat/part-19-quality-gate` (from `main` at `686d8a1`).

### Command results

| Command | Result |
| --- | --- |
| prettier check, lint (0 warnings), typecheck (app + tests), build, `npm audit --audit-level=high` | pass (0 vulnerabilities) |
| `npm run test:cov` | 553 passed, all per-area thresholds met |
| `npm run test:e2e` | 25 passed (16 foundation + 9 journey) |
| `npm run test:all` × 3 consecutively | 862 passed each run, 97.29 % lines each run, no flakes |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-19.1 | PASS | Required unit areas → files: graph validation `engine/validation/graph-validator.spec.ts`; condition evaluation `engine/expressions/conditions.spec.ts`; data resolver `engine/expressions/mapping.spec.ts`, `reference.spec.ts`; execution transitions `engine/execution/transitions.spec.ts`, `execution-engine.spec.ts`; retry classification `engine/errors.spec.ts`, `error-categories.spec.ts`, `common/http/fetch-failure.spec.ts`, `infrastructure/queue` backoff in `integrations/slack/slack.spec.ts`; node handlers `execution-engine.spec.ts` (built-ins), `modules/ai/ai.spec.ts`, `integrations/slack/slack.spec.ts`, `integrations/microsoft/microsoft.spec.ts`, `integrations/github/github.spec.ts`, `execution/side-effects.spec.ts`; encryption `infrastructure/crypto/envelope.spec.ts`, `encryption.service.spec.ts`; redaction `common/security/redaction.spec.ts`, `infrastructure/logger/logger.module.spec.ts`; config validation `config/env.schema.spec.ts`. Coverage table above |
| AC-19.2 | PASS | Required integration areas → files: authentication `auth.int-spec.ts`, `auth-throttle.int-spec.ts`; authorization `workspaces.int-spec.ts`, `api-hardening.int-spec.ts` (route inventory); workspace isolation `tenant-isolation.int-spec.ts`; workflow CRUD `workflows.int-spec.ts`; publishing `publishing.int-spec.ts`; webhook validation `webhooks.int-spec.ts`, `github.int-spec.ts`; idempotency (Part 15 S1–S8) `reliability.int-spec.ts`; persistence constraints `schema.int-spec.ts`; run history `runs.int-spec.ts` (plus `execution`, `credentials`, `ai`, `slack`, `microsoft`) |
| AC-19.3 | PASS (local; CI on the PR) | `test/e2e/journey.e2e-spec.ts`: register → login → create workspace → create workflow → draft (`test.event` → condition → `util.log` ×2) → publish → signed webhook (202, 1 run) → worker executes → run SUCCEEDED via `GET /runs`, detail and steps (`alert` SUCCEEDED with rendered message, `ignore` SKIPPED) |
| AC-19.4 | PASS (local; CI on the PR) | Same file: invalid signature → 401, no run; duplicate delivery → 200 `duplicate`, one run; failing node → run FAILED with `PERMANENT_PROVIDER_ERROR` and `failedStep`; another user → 404 for the run, its steps and via their own workspace (same response as an unknown id); no secret in any log line |
| AC-19.5 | PASS (with deviation) | Per-area unit thresholds enforced in `jest.config.json` (raising one to 99.9 % made `npm run test:cov` exit 1). **Deviation:** the global 70 % floor is enforced over **all suites together** (`test/jest-all.json`, 97.3 %), not over unit tests alone (48.7 %). Services, controllers and Prisma stores are deliberately tested against real Postgres/Redis in integration tests; reaching 70 % with unit tests alone would mean re-testing them against mocked Prisma with less fidelity. Open to revisit if a unit-only floor is wanted |
| AC-19.6 | PASS (local) | `npm run test:all` three times in a row: 862/862 each time. CI history accrues from this PR |

### Found and fixed during this part

- **Every API request returned 500 while Redis was connecting or unavailable** (Part 18's Redis rate limiting threw instead of degrading; it only passed before because other setup gave Redis time to connect). Rate limiting now **fails open** with a throttled warning, and the Redis client waits (≤ 5 s, non-fatal) for its first connection at startup. Tests: unit (`redis-throttler.storage.spec.ts`), integration (`api-hardening`: Redis errors → login still 401, not 500/429; mutation "fail closed" fails it). This also restores Part 15 S7 (webhooks accepted during a Redis outage).
- **E2E tests ran against the development database** (`.env`); they now use the isolated test database.
- **A refactoring bug caught before it landed:** a first version of the shared log-capture helper copied an empty array, which would have made log-scan assertions pass vacuously; fixed, and the suites that assert specific log messages prove capture works.
- `testTimeout` is ignored in Jest multi-project runs (S4 tests timed out at 5 s only in the combined run); replaced by `jest.setTimeout` in a setup file.
