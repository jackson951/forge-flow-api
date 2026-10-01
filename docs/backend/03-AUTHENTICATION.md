# 03 — Authentication

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

## Objective

Implement local email/password authentication with short-lived JWT access tokens and rotating, revocable refresh tokens, so every protected endpoint can trust `request.user`.

## Why This Part Exists

Authorization, workspace isolation and every user-facing feature depend on a reliable identity. The global guard currently rejects every non-public request; this part makes it verify real credentials.

## Scope

Register, login, refresh, logout, logout-all, current user; password hashing; JWT issuance/verification; refresh-token rotation with reuse detection; auth guard; login throttling.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-03.1 | A user registers with email, name and password; email is normalised (trimmed, lower-cased) and must be unique. |
| FR-03.2 | Registration also creates a personal workspace with the user as `OWNER` (in one transaction). |
| FR-03.3 | Login with correct credentials returns an access token and a refresh token. |
| FR-03.4 | Login with an unknown email or wrong password returns the same `401` message and similar timing. |
| FR-03.5 | Refresh exchanges a valid refresh token for a new pair; the old refresh token is revoked (rotation). |
| FR-03.6 | Presenting an already-rotated refresh token revokes the entire token family (reuse detection) and returns `401`. |
| FR-03.7 | Logout revokes the presented refresh token's family. Logout-all revokes every refresh token of the user. |
| FR-03.8 | `GET /auth/me` returns the authenticated user's public profile. |
| FR-03.9 | Access tokens expire after `JWT_ACCESS_TTL` (default 15 min); refresh tokens after `JWT_REFRESH_TTL` (default 7 days). |

## Technical Requirements

- **Hashing:** argon2id (`argon2` package) with library defaults ≥ OWASP minimums. A dummy hash is verified when the email is unknown to equalise timing.
- **Access token:** JWT HS256 signed with `JWT_ACCESS_SECRET`; claims `sub` (userId), `iat`, `exp`, `typ: "access"`; issuer/audience set and verified. No workspace claim — workspace access is resolved per request (Part 04), so role changes take effect immediately.
- **Refresh token:** opaque 256-bit random value (base64url), not a JWT. Stored as SHA-256 hash in `RefreshToken` with `familyId`. Rotation marks the old row `revokedAt` + `replacedById`.
- **Transport:** refresh token returned in the JSON body and also set as an `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` cookie. The refresh endpoint accepts either (cookie preferred). Access token is returned in the body only; clients send `Authorization: Bearer`.
- **Guard:** the global `AuthGuard` verifies the bearer token, loads nothing from the DB on the hot path, and attaches `{ userId }` to `request.user`. `@Public()` bypasses it.
- **Concurrency:** rotation uses a conditional update (`WHERE id = ? AND revokedAt IS NULL`) so two simultaneous refreshes with the same token cannot both succeed.
- **Throttling:** `POST /auth/login` 5/min per IP+email, `POST /auth/register` 5/min per IP, `POST /auth/refresh` 30/min per IP (Part 18 moves storage to Redis).

## API Changes

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/api/v1/auth/register` | Public | `{ email, name, password }` | `201 { user, accessToken, refreshToken, expiresIn }` |
| POST | `/api/v1/auth/login` | Public | `{ email, password }` | `200 { user, accessToken, refreshToken, expiresIn }` |
| POST | `/api/v1/auth/refresh` | Public (refresh token) | `{ refreshToken }` or cookie | `200 { accessToken, refreshToken, expiresIn }` |
| POST | `/api/v1/auth/logout` | Public (refresh token) | `{ refreshToken }` or cookie | `204` |
| POST | `/api/v1/auth/logout-all` | Bearer | — | `204` |
| GET | `/api/v1/auth/me` | Bearer | — | `200 { id, email, name, createdAt }` |

Password policy: 12–128 characters. Error codes: `409` duplicate email, `401` bad credentials/invalid token, `400` validation, `429` throttled.

## Database Changes

Uses `User` and `RefreshToken` from Part 02. Optional columns `userAgent`, `ipHash` on `RefreshToken` for session visibility.

## Security Requirements

- Never store or log plaintext passwords or refresh tokens; never return `passwordHash`.
- Response serialisation uses explicit DTOs / Prisma `select`.
- Generic error messages; duplicate-email `409` is accepted as a known enumeration trade-off (documented), mitigated by register throttling.
- JWT secrets ≥ 32 chars, distinct, validated at startup.
- `alg` pinned to HS256 on verification (rejects `none` / algorithm confusion).
- Audit events: `auth.register`, `auth.login.failed` (without password), `auth.refresh.reuse_detected`, `auth.logout_all`.

## Testing Requirements

- Unit: password hashing/verify, token service (issue/verify/expired/wrong secret/wrong `typ`), rotation logic, reuse detection.
- Integration (real DB via Supertest): every acceptance criterion below, plus concurrent refresh race (two parallel requests, exactly one succeeds), response bodies never contain `passwordHash`.

## Deliverables

`AuthModule` (controller, service, token service, password service), `UsersService`, updated `AuthGuard`, DTOs with Swagger annotations, tests.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-03.1 | Valid registration → 201, user + tokens, personal workspace created | Integration |
| AC-03.2 | Duplicate email (case-insensitive) → 409 | Integration |
| AC-03.3 | Login with valid credentials → 200 with tokens | Integration |
| AC-03.4 | Wrong password and unknown email → identical 401 body | Integration |
| AC-03.5 | Protected route without / with malformed / with expired token → 401 | Integration |
| AC-03.6 | Refresh with valid token → new pair; old token then → 401 | Integration |
| AC-03.7 | Reusing a rotated token revokes the family (new token from the same family also → 401) | Integration |
| AC-03.8 | Logout → refresh token unusable; logout-all → all user refresh tokens unusable | Integration |
| AC-03.9 | Password hash never appears in any response | Integration asserts on serialized bodies |
| AC-03.10 | 6th login attempt within a minute → 429 | Integration |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Email verification, password reset, MFA, social login for FlowForge accounts (OAuth is only for integrations), account deletion.

## Dependencies

Parts 01, 02.

## Risks / Design Questions

- **Access-token revocation:** stateless JWTs remain valid until expiry after logout. Accepted with a 15-minute TTL; documented as a known limitation.
- **Cookie vs body refresh tokens:** supporting both keeps API clients (Swagger, tests) simple while letting the SPA use the HttpOnly cookie. If the frontend adopts cookies exclusively, body transport can be disabled by config.
- **Account enumeration via register** — see Security Requirements.

## Implementation Notes

- Existing `RegisterDto`/`LoginDto` are reused; add `@Transform` for email normalisation.
- Use `@nestjs/jwt` for signing/verification.
