import { Injectable } from '@nestjs/common';
import { ConnectionStatus, ErrorCategory, IntegrationProviderKey } from '@prisma/client';
import { PermanentError } from '../engine/errors';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { CredentialStore } from '../modules/integrations/credentials/credential-store';

/** What integration handlers may do with connections. Always scoped to the run's workspace. */
export interface ConnectionAccess {
  /** Decrypted access token of a CONNECTED connection of `provider` in `workspaceId`. */
  accessToken(
    workspaceId: string,
    connectionId: string,
    provider: IntegrationProviderKey,
  ): Promise<string>;
  /** The provider rejected the token: the user has to reconnect. */
  markNeedsAttention(workspaceId: string, connectionId: string): Promise<void>;
}

/**
 * Worker-side credential access for node handlers (Part 17: plaintext only in handler scope).
 * A connection from another workspace, of another provider, or not CONNECTED is refused the
 * same way, so handlers cannot be pointed at other tenants' credentials.
 */
@Injectable()
export class WorkerConnections implements ConnectionAccess {
  constructor(
    private readonly credentials: CredentialStore,
    private readonly prisma: PrismaService,
  ) {}

  async accessToken(
    workspaceId: string,
    connectionId: string,
    provider: IntegrationProviderKey,
  ): Promise<string> {
    const connection = await this.credentials.get(workspaceId, connectionId);
    if (
      !connection ||
      connection.provider !== provider ||
      connection.status !== ConnectionStatus.CONNECTED ||
      !connection.accessToken
    ) {
      throw new PermanentError(
        ErrorCategory.PROVIDER_AUTH,
        `The ${provider} connection is missing or needs attention; reconnect it`,
      );
    }
    await this.prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { lastUsedAt: new Date() },
    });
    return connection.accessToken;
  }

  async markNeedsAttention(workspaceId: string, connectionId: string): Promise<void> {
    await this.prisma.integrationConnection.updateMany({
      where: { id: connectionId, workspaceId },
      data: { status: ConnectionStatus.NEEDS_ATTENTION },
    });
  }
}
