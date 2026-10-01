# 18 — Rate Limiting and API Hardening

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

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
| FR-18.7 | No user-configurable outbound URL exists. If an HTTP-request node is ever added, it must pass the SSRF policy below first. |

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
