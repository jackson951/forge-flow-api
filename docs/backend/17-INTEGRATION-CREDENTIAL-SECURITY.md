# 17 — Integration Credential Security

**Status:** COMPLETE (2026-10-02) — evidence below; see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Protect third-party credentials across their whole lifecycle — acquisition, storage, use, display, logging, rotation and revocation — and prove with tests that they never leave the backend.

## Why This Part Exists

A FlowForge database leak or a careless API response would expose users' GitHub/Slack/Microsoft access. Credential handling is the highest-impact security area of the product.

## Scope

Encryption service, key management, credential repository, OAuth state storage, redaction (logs, errors, step I/O), public DTOs, disconnect/revoke flow, rotation procedure, secrets-in-definitions guard, threat model.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-17.1 | All provider tokens and PKCE verifiers are encrypted before persistence. |
| FR-17.2 | Integration APIs return connection metadata only (`id`, `provider`, `status`, `accountLabel`, `scopes`, `createdAt`, `lastUsedAt`). |
| FR-17.3 | Disconnect revokes at the provider where supported (Slack `auth.revoke`, GitHub App: instruct uninstall; Microsoft: none via API, documented), deletes the credential row and marks the connection `DISCONNECTED`; active versions referencing it fail with `PROVIDER_AUTH`. |
| FR-17.4 | Workflow definitions can't contain secrets (validator rejects secret-like keys and token-looking values). |
| FR-17.5 | Key rotation: new key ID can be introduced; old ciphertexts remain decryptable; a re-encrypt command migrates rows. |

## Technical Requirements

- **Algorithm:** AES-256-GCM, random 96-bit IV per encryption, 128-bit tag.
- **Format:** `v1.<keyId>.<iv b64url>.<tag b64url>.<ciphertext b64url>`.
- **AAD:** `${connectionId}:${fieldName}` — prevents swapping ciphertexts between rows/fields.
- **Keys:** `ENCRYPTION_KEYS` = comma-separated `keyId:base64(32 bytes)`, `ENCRYPTION_ACTIVE_KEY_ID`. Validated at startup (exact length); required when any integration is enabled. Supplied via environment/secret manager; never in repo.
- **Access pattern:** only `CredentialStore.getDecrypted(workspaceId, connectionId)` decrypts; used in worker handlers and OAuth refresh code. API controllers never import it (enforced by an architecture test).
- **Redaction:** pino `redact` paths + a value-based redactor for step I/O and errors (keys matching `/token|secret|password|authorization|api[-_]?key|cookie|signature/i`, and values matching known token prefixes `xox[abp]-`, `ghs_`, `gho_`, `ghp_`, `eyJ` JWT pattern, `Bearer `).
- **Serialization:** public DTO mappers; Prisma queries for connections never `include` credentials.
- **Threat assumptions:** attacker may obtain a DB dump or logs, or may be an authenticated user of another workspace; attacker does not control the running process or its environment. Encryption at rest protects against DB/backup leaks, not against a compromised app server.

## API Changes

| Method | Path | Min role |
| --- | --- | --- |
| GET | `/api/v1/workspaces/:workspaceId/integrations` | MEMBER |
| GET | `/api/v1/workspaces/:workspaceId/integrations/:connectionId` | MEMBER |
| DELETE | `/api/v1/workspaces/:workspaceId/integrations/:connectionId` | ADMIN |

## Database Changes

`IntegrationCredential` (ciphertext columns, `keyId`), `OAuthState` (hash of state, encrypted verifier). CLI script `npm run credentials:reencrypt`.

## Security Requirements

This part *is* the security requirement set; additionally: audit events for connect, disconnect, reencrypt; decrypt failures logged without ciphertext.

## Testing Requirements

- Unit: encrypt/decrypt round trip; tampered ciphertext/tag/AAD rejected; wrong key rejected; multiple keys; format parsing; redactor on nested objects, arrays, headers, error messages.
- Integration: DB rows contain no plaintext canary token; every integrations endpoint response scanned for canary values and credential field names; logs captured during connect/run/disconnect contain no canary; definition with `apiKey` field rejected; disconnect deletes credential and subsequent run fails with `PROVIDER_AUTH`; architecture test (no controller imports `CredentialStore`).

## Deliverables

`EncryptionService` (replacing stub), `CredentialStore`, `OAuthStateService`, redactor, DTO mappers, reencrypt script, threat model section (above), tests.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-17.1 | Credentials encrypted at rest with authenticated encryption | Unit + DB inspection test |
| AC-17.2 | Key supplied only via environment/secret manager; startup validation | Unit (config) + repo scan |
| AC-17.3 | API never returns raw tokens | Response-scan integration tests |
| AC-17.4 | Logs redact Authorization headers and token values | Log capture tests |
| AC-17.5 | Secrets rejected in workflow definitions | Unit + integration |
| AC-17.6 | Disconnect removes credentials and revokes where supported | Integration (mocked provider) |
| AC-17.7 | Key rotation procedure works | Integration: encrypt with k1, rotate to k2, reencrypt, decrypt |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

HSM/KMS integration (documented as production recommendation: envelope encryption with cloud KMS), per-workspace keys.

## Dependencies

Part 02. Implement the encryption service early (before Part 10's OAuth state) — this part's audit/hardening can complete after Parts 10–14.

## Risks / Design Questions

- Loss of encryption keys = loss of all connections (users must reconnect); documented in operations notes.

## Implementation Notes

The scaffold `EncryptionService` stub and `REDACTED_PATHS` are the starting points.

## Threat model (as implemented)

| Attacker / event | Protected by | Residual risk |
| --- | --- | --- |
| Database dump or backup leak | AES-256-GCM ciphertext only; keys live outside the database (env / secret manager); OAuth state stored as SHA-256 hash; refresh tokens as HMAC | An attacker with **both** the DB and the keys can decrypt |
| Ciphertext swapping inside the DB (attacker with write access moves a token to another connection) | AAD `<connectionId>:<field>` — moved ciphertext fails to decrypt | Deleting/replacing rows is still possible with DB write access |
| Authenticated user of another workspace | Workspace-scoped reads in `CredentialStore.get`; tenant guard; publish-time connection check (Part 10) | — |
| Leaks through API responses | Explicit `CONNECTION_SELECT` without the credential relation; architecture test; response scans | — |
| Leaks through logs | Path redaction (headers, known fields) **and** value-based scrubbing of token shapes in every log object | Novel token formats not matching any pattern; mitigated by never logging provider payloads |
| Secrets pasted into workflow definitions | `SECRET_IN_CONFIG` for credential-like keys and token-shaped values | Unrecognised custom formats |
| Compromised running app server | Out of scope: the process necessarily holds keys and decrypted tokens in memory | Use a KMS with envelope encryption and short-lived tokens in production |
| Key loss | — | All encrypted connections must be reconnected; back keys up in a secret manager |

## Operations: key rotation

1. Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. `ENCRYPTION_KEYS=old:<…>,new:<…>`, `ENCRYPTION_ACTIVE_KEY_ID=new`; deploy (new writes use `new`, old rows stay readable).
3. `npm run credentials:reencrypt` (built) or `npm run credentials:reencrypt:dev`. Exit code 1 lists connections that could not be decrypted (corrupted or under a missing key) — keep the old key and reconnect those.
4. When it reports no failures, remove `old` from `ENCRYPTION_KEYS`.

## Implementation Evidence

Verified 2026-10-02 on branch `feat/part-17-credential-security` (from `main` at `142623b`).

### What was implemented

| Item | Location |
| --- | --- |
| Envelope encryption `v1.<keyId>.<iv>.<tag>.<ct>`, AES-256-GCM, random IV, AAD binding, keyring parsing | `src/infrastructure/crypto/envelope.ts`, `encryption.service.ts` |
| Config: `ENCRYPTION_KEYS` / `ENCRYPTION_ACTIVE_KEY_ID` validated at startup (32-byte keys, active key exists, errors never echo key material); required in production when Slack or Microsoft is configured | `src/config/env.schema.ts` |
| `CredentialStore`: save, workspace-scoped get, cursor-based `reencryptAll` that skips and reports undecryptable rows; audit `integration.credentials_reencrypted` | `src/modules/integrations/credentials/credential-store.ts` |
| Re-encryption command (`credentials:reencrypt`, `credentials:reencrypt:dev`) | `src/scripts/reencrypt-credentials.ts`, `package.json` |
| Disconnect: provider `revoke` hook (best effort), then delete connection + credentials (cascade); audit records whether revocation succeeded | `integrations.service.ts`, `integration-provider.interface.ts` |
| Shared redactor (key- and value-based); used by step storage, the definition validator and the logger (`formatters.log`), extended header redaction paths | `src/common/security/redaction.ts`, `src/engine/execution/sanitize.ts`, `src/infrastructure/logger/logger.module.ts`, `src/common/utils/redact.ts` |
| Architecture test: only allowed modules import the credential store; no controller or webhook code imports credential storage or decryption; connection response select has no credential relation | `src/security-architecture.spec.ts` |

### Command results

| Command | Result |
| --- | --- |
| prettier check, lint, typecheck, build | pass |
| `npm test` | 386 passed |
| `npm run test:e2e` | 16 passed |
| `npm run test:int` | 203 passed (8 in `credentials.int-spec.ts`) |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-17.1 | PASS | Unit: round trip, fresh IV, tampered IV/tag/ciphertext, wrong key, unknown key id, wrong AAD all rejected. Integration: DB row holds only `v1.test1.…`; a raw `SELECT` contains no canary |
| AC-17.2 | PASS | Keys only from env (validated at boot; no key in the repo — `.env.example` documents generation only); unit tests for short keys, unknown active id, production requirement |
| AC-17.3 | PASS | Integration: connection list response field-by-field without credential/ciphertext; architecture test over all controllers and webhook code |
| AC-17.4 | PASS | Unit: a real pino instance with the app's options removes Slack/GitHub tokens, bearer headers, credential fields and cookie/signature headers; Part 10 log scan of a full suite found none |
| AC-17.5 | PASS | Token-shaped values (and credential-like keys) in node config → `SECRET_IN_CONFIG` (unit + integration) |
| AC-17.6 | PASS | Disconnect calls the provider's revoke with the decrypted credential, deletes connection and credential, audits `revokedAtProvider`; a failing revocation still deletes locally |
| AC-17.7 | PASS | Integration: encrypt with `test1` → re-encrypt with `k2` active → only `k2` configured still decrypts; old key alone fails; re-run migrates nothing. **Built CLI:** `npm run credentials:reencrypt` against the test DB with `ENCRYPTION_KEYS=a:…,b:…`, active `b` → "Re-encrypted 1 credential row(s)", exit 0, row key id `a` → `b`, decrypts with `b` alone |

### Found and fixed during this part

- **Key rotation stopped at the first unreadable row** (and the batch loop would have retried that row forever). Rotation now walks rows once with a cursor, re-encrypts each independently and reports failed connection ids; the CLI exits 1 when any remain.

### Notes

- GitHub stores no tokens (Part 10), so today only test data exercises the store; Slack (Part 13) and Microsoft (Part 14) are the first real users. Microsoft's PKCE verifier (`OAuthState.encryptedCodeVerifier`) will use the same service.
- Production recommendation (out of scope): envelope encryption with a cloud KMS so the app never holds the master key.
