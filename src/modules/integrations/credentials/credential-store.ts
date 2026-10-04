import { Injectable } from '@nestjs/common';
import {
  ConnectionStatus,
  ConnectionStatusReason,
  IntegrationProviderKey,
  Prisma,
} from '@prisma/client';
import { EncryptionService } from '../../../infrastructure/crypto/encryption.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

export interface Credential {
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: Date | null;
}

export interface DecryptedConnection extends Credential {
  connectionId: string;
  provider: IntegrationProviderKey;
  status: ConnectionStatus;
  statusReason: ConnectionStatusReason | null;
  externalAccountId: string;
}

type Field = 'accessToken' | 'refreshToken' | 'payload';

/** HTTP connection secrets (Part 24): field name → secret value, sealed as one JSON payload. */
export type SecretPayload = Record<string, string>;

export interface HttpConnectionSecrets {
  connectionId: string;
  status: ConnectionStatus;
  metadata: Prisma.JsonValue;
  secrets: SecretPayload;
}

/** Binds each ciphertext to its connection and field (AES-GCM additional data). */
const aad = (connectionId: string, field: Field) => `${connectionId}:${field}`;

/**
 * The only code that reads or writes plaintext provider credentials.
 *
 * - Plaintext exists only in memory, only in OAuth/refresh code and worker handlers; API
 *   controllers never import this class (enforced by an architecture test).
 * - Reads are scoped by workspace: a connection id from another workspace returns null.
 * - Rows remember their key id so keys can be rotated with `reencryptAll`.
 */
@Injectable()
export class CredentialStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async save(
    connectionId: string,
    credential: Credential,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const data = {
      keyId: this.encryption.currentKeyId,
      encryptedAccessToken: this.seal(connectionId, 'accessToken', credential.accessToken),
      encryptedRefreshToken: this.seal(connectionId, 'refreshToken', credential.refreshToken),
      accessTokenExpiresAt: credential.accessTokenExpiresAt ?? null,
    };
    await tx.integrationCredential.upsert({
      where: { connectionId },
      create: { connectionId, ...data },
      update: data,
    });
  }

  /** Seals HTTP connection secrets (replacing previous ones) under the active key. */
  async savePayload(
    connectionId: string,
    payload: SecretPayload,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const data = {
      keyId: this.encryption.currentKeyId,
      encryptedPayload: this.seal(connectionId, 'payload', JSON.stringify(payload)),
    };
    await tx.integrationCredential.upsert({
      where: { connectionId },
      create: { connectionId, ...data },
      update: data,
    });
  }

  /** An HTTP connection of this workspace with its decrypted secrets, or null. */
  async getHttp(workspaceId: string, connectionId: string): Promise<HttpConnectionSecrets | null> {
    const connection = await this.prisma.integrationConnection.findFirst({
      where: { id: connectionId, workspaceId, provider: IntegrationProviderKey.HTTP },
      select: {
        id: true,
        status: true,
        metadata: true,
        credential: { select: { encryptedPayload: true } },
      },
    });
    if (!connection) return null;
    const sealed = this.open(connection.id, 'payload', connection.credential?.encryptedPayload);
    return {
      connectionId: connection.id,
      status: connection.status,
      metadata: connection.metadata,
      secrets: sealed ? (JSON.parse(sealed) as SecretPayload) : {},
    };
  }

  async get(
    workspaceId: string,
    connectionId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<DecryptedConnection | null> {
    const connection = await tx.integrationConnection.findFirst({
      where: { id: connectionId, workspaceId },
      select: {
        id: true,
        provider: true,
        status: true,
        statusReason: true,
        externalAccountId: true,
        credential: {
          select: {
            encryptedAccessToken: true,
            encryptedRefreshToken: true,
            accessTokenExpiresAt: true,
          },
        },
      },
    });
    if (!connection) return null;
    const c = connection.credential;
    return {
      connectionId: connection.id,
      provider: connection.provider,
      status: connection.status,
      statusReason: connection.statusReason,
      externalAccountId: connection.externalAccountId,
      accessToken: this.open(connection.id, 'accessToken', c?.encryptedAccessToken),
      refreshToken: this.open(connection.id, 'refreshToken', c?.encryptedRefreshToken),
      accessTokenExpiresAt: c?.accessTokenExpiresAt ?? null,
    };
  }

  /**
   * Like `get`, inside `tx` and holding a row lock on the credential until the transaction
   * ends: serialises token refreshes for one connection across processes (Part 14).
   */
  async getLocked(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    connectionId: string,
  ): Promise<DecryptedConnection | null> {
    await tx.$queryRaw`
      SELECT c.id FROM "IntegrationCredential" c
      JOIN "IntegrationConnection" ic ON ic.id = c."connectionId"
      WHERE c."connectionId" = ${connectionId}::uuid AND ic."workspaceId" = ${workspaceId}::uuid
      FOR UPDATE OF c`;
    return this.get(workspaceId, connectionId, tx);
  }

  /**
   * Re-encrypts every credential not yet under the active key. Safe to re-run; each row is
   * updated only if its key id is still the one that was read (no lost concurrent updates).
   *
   * Rows that cannot be decrypted (corrupted, or their key is no longer configured) are
   * skipped and reported by connection id — one bad row must not block the rotation. Such a
   * connection has to be reconnected; keep the old key until `failed` is empty.
   */
  async reencryptAll(batchSize = 100): Promise<{ updated: number; failedConnectionIds: string[] }> {
    const activeKeyId = this.encryption.currentKeyId;
    let updated = 0;
    const failedConnectionIds: string[] = [];
    let cursor: string | undefined;

    for (;;) {
      const rows = await this.prisma.integrationCredential.findMany({
        where: { keyId: { not: activeKeyId }, ...(cursor && { id: { gt: cursor } }) },
        orderBy: { id: 'asc' },
        take: batchSize,
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;

      for (const row of rows) {
        const reseal = (field: Field, value: string | null) =>
          value === null
            ? null
            : this.encryption.encrypt(
                this.encryption.decrypt(value, aad(row.connectionId, field)),
                aad(row.connectionId, field),
              );
        let data: Prisma.IntegrationCredentialUpdateManyMutationInput;
        try {
          data = {
            keyId: activeKeyId,
            encryptedAccessToken: reseal('accessToken', row.encryptedAccessToken),
            encryptedRefreshToken: reseal('refreshToken', row.encryptedRefreshToken),
            encryptedPayload: reseal('payload', row.encryptedPayload),
          };
        } catch {
          failedConnectionIds.push(row.connectionId);
          continue;
        }
        const result = await this.prisma.integrationCredential.updateMany({
          where: { id: row.id, keyId: row.keyId },
          data,
        });
        updated += result.count;
      }
    }

    await this.prisma.auditEvent.create({
      data: {
        action: 'integration.credentials_reencrypted',
        metadata: { updated, failed: failedConnectionIds.length, keyId: activeKeyId },
      },
    });
    return { updated, failedConnectionIds };
  }

  private seal(connectionId: string, field: Field, value?: string): string | null {
    return value ? this.encryption.encrypt(value, aad(connectionId, field)) : null;
  }

  private open(connectionId: string, field: Field, value?: string | null): string | undefined {
    return value ? this.encryption.decrypt(value, aad(connectionId, field)) : undefined;
  }
}
