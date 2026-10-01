# 17 — Integration Credential Security

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

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
