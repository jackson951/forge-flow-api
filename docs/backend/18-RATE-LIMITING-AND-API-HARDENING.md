# 18 — Rate Limiting and API Hardening

**Status:** COMPLETE (2026-10-02) — evidence below; AC-18.7 is verified locally and the audit step runs in CI from this branch on; see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Harden the public API surface against abuse, resource exhaustion and common web vulnerabilities, and review authorization across every endpoint.

## Why This Part Exists

Earlier parts add limits locally; this part makes them consistent, distributed across instances, and verified.

## Scope

Rate limiting (auth, general, webhook), body/payload limits, validation review, CORS/Helmet review, exception sanitisation review, authorization review of all routes, pagination and workflow size limits, provider timeout review, SSRF policy, dependency audit.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-18.1 | Rate limits stored in Redis so they hold across API instances. |
| FR-18.2 | Limits: login 5/min per IP+email and 20/min per IP; register 5/min per IP; refresh 30/min per IP; authenticated API 300/min per user; webhooks 600/min per provider per IP. `429` with `Retry-After`. |
| FR-18.3 | JSON body limit 256 KB globally; 1 MB on webhook routes; `413` beyond. URL-encoded bodies disabled except OAuth callbacks (query only). |
| FR-18.4 | Pagination `limit` max 100 everywhere. |
| FR-18.5 | Workflow limits (Part 05) enforced: 50 nodes, 100 edges, 256 KB definition. |
| FR-18.6 | Every outbound provider call has a timeout (≤ 30 s). |
| FR-18.7 | No user-configurable outbound URL exists. If an HTTP-request node is ever added, it must pass the SSRF policy below first. *(Planned: [Part 24](24-HTTP-REQUEST-AND-CUSTOM-API.md) implements this policy; open decision on plain HTTP for self-hosted/dev.)* |

## Technical Requirements

- Current state (from Parts 01–05): JSON body limit 300 KB, body-parser errors mapped to clean 400/413 envelopes without echoing input. This part settles final limits.
- `@nestjs/throttler` with Redis storage (`@nest-lab/throttler-storage-redis` or equivalent), custom tracker for IP+email and user ID. Trust proxy configured explicitly (`TRUST_PROXY` hop count) so `req.ip` is correct behind a load balancer.
- Helmet with API-appropriate CSP (`default-src 'none'`) except Swagger route; `Cross-Origin-Resource-Policy: same-site`.
- CORS: explicit origins, `credentials: true`, methods/headers allow-list, no wildcard with credentials.
- ValidationPipe: whitelist/forbid, `transform` with `enableImplicitConversion: false`, max array sizes on DTOs.
- **SSRF policy (for any future configurable HTTP):** HTTPS only; resolve DNS and reject private, loopback, link-local, CGNAT, metadata (169.254.169.254) and IPv6 equivalents; re-check after redirects (or disable redirects); pin resolved IP for the request; response size and time limits; per-workspace allow-list.
- Dependency audit: `npm audit --audit-level=high` in CI; Dependabot/Renovate config.
- Authorization review: generated route inventory (from Nest router) compared against a table of expected guards/roles in a test — new routes without an entry fail the test.

## API Changes

No new endpoints; `429`/`413` behaviour and `Retry-After` header documented in Swagger.

## Database Changes

None.

## Security Requirements

As above; plus: errors never echo request bodies; `ParseUUIDPipe` on all ID params.

## Testing Requirements

Integration: 429 thresholds for each auth route and webhook route; limits apply across two app instances sharing Redis; 413 for oversize bodies; pagination limit 101 → 400; route inventory test; security headers snapshot; CORS disallowed origin; malformed JSON → 400 envelope without echo.

## Deliverables

Throttler Redis storage, limit configuration, body parser config, route authorization inventory test, SSRF policy doc (this file), CI audit step, tests.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-18.1 | Auth endpoints rate limited per FR-18.2 | Integration |
| AC-18.2 | Limits shared across instances | Integration with two apps |
| AC-18.3 | Oversize payloads → 413 | Integration |
| AC-18.4 | Every route has an explicit auth/role expectation | Route inventory test |
| AC-18.5 | Pagination and workflow size limits enforced | Integration |
| AC-18.6 | All provider clients have timeouts | Unit per client |
| AC-18.7 | `npm audit --audit-level=high` clean or exceptions documented | CI output |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

WAF, bot detection, CAPTCHA, account lockout (rate limiting instead).

## Dependencies

Parts 01, 03, 04, 09; best done after Parts 10–14 so all routes exist.

## Risks / Design Questions

- IP-based limits are weak behind shared NATs; per-email limits complement them.

## Implementation Notes

Scaffold already has a global in-memory `ThrottlerGuard` and per-route `@Throttle` on auth/webhooks; this part moves storage to Redis and completes coverage.

## As implemented

### Rate limits (`src/common/throttling/rate-limits.ts`)

| Scope | Limit / min | Key |
| --- | --- | --- |
| Authenticated routes | 300 | user id (`default` throttler) |
| Any route | 3 000 | client IP (`ip` throttler, flood cap) |
| `POST /auth/login` | 5 and 20 | IP + email, and IP |
| `POST /auth/register` | 5 | IP |
| `POST /auth/refresh` | 30 | IP |
| `POST /webhooks/:provider` | 600 | provider + IP |

- Counters live in **Redis** (`RedisThrottlerStorage`, one atomic Lua script per hit: fixed window + block key), under `<QUEUE_PREFIX>:throttle:*`, so every API instance shares them. No new dependency.
- The throttler guard now runs **after** the auth guard, so authenticated limits are per user (before, it ran first and could only count per IP). Public routes are still limited by IP / IP+email. Requests with an invalid token are rejected by the cheap JWT check before being counted.
- Exceeding a limit → `429` with `Retry-After` (seconds); documented in the Swagger description.
- `TRUST_PROXY` (hop count, default 0) sets Express `trust proxy`, so `req.ip` is the client behind a load balancer.

### Request handling

| Item | Implementation |
| --- | --- |
| Body parsers | App created with `bodyParser: false` (`APP_OPTIONS`); only JSON parsers are registered: **300 KB** globally, 1 MB on `/webhooks` (raw body kept for signatures). URL-encoded and other bodies are not parsed. Oversize → 413, malformed → 400, neither echoes the body |
| Body limit decision | **300 KB, not 256 KB:** the largest legal workflow draft (256 KB definition, FR-18.5) plus its request envelope must fit. Recorded deviation |
| Validation | `whitelist`, `forbidNonWhitelisted`, `transform`, `enableImplicitConversion: false` (explicit `@Type` on query numbers); no DTO has array fields (workflow arrays are capped by the definition schema) |
| Pagination | `limit` ≤ 100 on every list (runs, workflows, versions, channels via the shared DTO) |
| Workflow size | Drafts over 50 nodes, 100 edges or 256 KB are refused with 400 `LIMIT_EXCEEDED` (never stored) |
| Helmet | API: `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (no helmet defaults merged), `Cross-Origin-Resource-Policy: same-site`, HSTS, nosniff, no `X-Powered-By`. Swagger UI (`/api/docs`): helmet's standard CSP so it can load its own assets |
| CORS | Explicit origins (`CORS_ORIGINS`, never `*`), credentials, methods `GET,POST,PUT,PATCH,DELETE`, headers `Authorization, Content-Type, Idempotency-Key, x-request-id`, exposes `x-request-id`, `Retry-After` |
| Provider timeouts | GitHub 10 s, Slack 10 s, Microsoft 15 s, AI `AI_TIMEOUT_MS` (default 20 s, max 30 s enforced at startup); a test fails if any source file calls `fetch` without `AbortSignal.timeout` |
| SSRF | No node type accepts a URL/host setting (test over every node type's config schema); provider base URLs are server configuration only. Microsoft paging links are followed only on the Graph host (Part 14). The policy above applies before any configurable HTTP node is added |
| Dependencies | `npm audit --audit-level=high` in CI; Dependabot (npm weekly, grouped Nest/Prisma; GitHub Actions monthly) |

### Dependency audit exceptions

None remaining. Two advisories were fixed with **scoped npm overrides** (no major upgrades or downgrades):

| Package | Advisory | Path | Fix |
| --- | --- | --- | --- |
| `deepmerge-ts` < 8 (high) | stack exhaustion merging recursive objects | `prisma` → `@prisma/config` (CLI config loading only) | `overrides["@prisma/config"]["deepmerge-ts"] = 8.0.2`; `prisma validate`, `generate`, `migrate status/deploy` verified |
| `js-yaml` 5.0–5.4.0 (moderate) | CPU use with empty merge sources | `@nestjs/swagger` | `overrides["@nestjs/swagger"]["js-yaml"] = 5.4.2`; Swagger UI verified |

npm's own suggestion was a Prisma downgrade (6.12) and a Swagger major upgrade; the scoped overrides keep the versions in use and touch nothing else (a global `js-yaml` override would break tools that need v3/v4).

## Implementation Evidence

Verified 2026-10-02 on branch `feat/part-18-api-hardening` (from `main` at `5779749`).

### Command results

| Command | Result |
| --- | --- |
| prettier check, lint (0 warnings), typecheck, build | pass |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `npm test` | 546 passed (`provider-timeouts.spec.ts`, `no-outbound-urls.spec.ts`) |
| `npm run test:e2e` | 16 passed |
| `npm run test:int` | 286 passed (16 in `test/integration/api-hardening.int-spec.ts`) |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-18.1 | PASS | Integration: login 5 per IP+email (other email / other IP unaffected), 20 per IP across emails; register 5; refresh 30; authenticated 300 per user (another user unaffected); webhooks 600 per provider+IP (another provider unaffected); every 429 carries `Retry-After` |
| AC-18.2 | PASS | Two API instances sharing Redis: requests alternate between them and the limits hold in total (mutation: in-memory storage → 5 rate-limit tests fail) |
| AC-18.3 | PASS | 310 KB JSON → 413 without echo; 400 KB signed webhook (event data < 256 KB) → 202; 1.1 MB webhook → 413; URL-encoded registration not parsed (400, no user created); malformed JSON → 400 without echo |
| AC-18.4 | PASS | Route inventory: every controller method's access (public/user/member/admin/owner) read from decorators equals the reviewed table, and the table equals every served `/api/v1` route; malformed path ids on every route → 400/404, never 2xx/500 (the OAuth callback always redirects with `reason=unknown_provider`) |
| AC-18.5 | PASS | `limit=101` → 400 and `limit=100` → 200 on runs, workflows, versions; drafts with 51 nodes, 101 edges or > 256 KB → 400 `LIMIT_EXCEEDED`, nothing saved |
| AC-18.6 | PASS | Unit per client: the signal passed to `fetch` comes from `AbortSignal.timeout` with the client's limit (≤ 30 s); `AI_TIMEOUT_MS` > 30 000 refused at startup; source scan for `fetch` without timeout |
| AC-18.7 | PASS (local) | `npm audit --audit-level=high` → 0 vulnerabilities after the overrides above; CI step added (`.github/workflows/ci.yml`) — CI output will show on the PR |

Also verified: API CSP is exactly `default-src 'none';frame-ancestors 'none'`; CORS rejects other origins and lists only the allowed methods/headers.

**Mutation checks** (each made tests fail, then reverted): in-memory throttle storage; throttler guard before the auth guard (per-user limit test); default body parsers re-enabled (URL-encoded test).

### Found and fixed during this part

- **Rate limits were per instance** (in-memory) — now in Redis.
- **"Per user" limits were impossible:** the throttler ran before authentication and only ever saw IPs.
- **Login had no per-IP limit** (password spraying across many emails from one IP); **webhooks were limited per IP for all providers together.**
- **URL-encoded bodies were parsed** (Nest's default parser) although the API only accepts JSON.
- **Helmet merged its default document CSP** into the API policy; the API now sends exactly `default-src 'none'`.
- **AI timeout was unbounded** in configuration; now ≤ 30 s.
- **3 high + 2 moderate dependency advisories** — fixed with scoped overrides.
