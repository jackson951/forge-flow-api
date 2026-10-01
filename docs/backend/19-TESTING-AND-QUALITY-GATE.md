# 19 — Testing and Quality Gate

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

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
