import { Injectable } from '@nestjs/common';
import { ConnectionStatus, ErrorCategory, IntegrationProviderKey } from '@prisma/client';
import { ExecutionError, PermanentError } from '../../../engine/errors';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { CredentialStore, DecryptedConnection } from '../credentials/credential-store';
import { GraphUnauthorizedError, MicrosoftClient, MicrosoftConsentError } from './microsoft-client';

/** Refresh when the access token expires within this window (FR-14.3). */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/** Row lock wait + one token request (15 s) must fit; generous to absorb a queued refresh. */
const REFRESH_TX = { maxWait: 10_000, timeout: 45_000 };

type Usable = DecryptedConnection & { refreshToken: string };

/**
 * Access tokens for Microsoft connections (delegated, per connecting user).
 *
 * - Tokens are refreshed shortly before expiry. Refreshes for one connection are serialised
 *   with a row lock on its credential (works across API and worker processes); whoever gets
 *   the lock second re-reads and uses the token the first one stored.
 * - The rotated refresh token is saved in the same transaction as the new access token.
 * - `invalid_grant` (consent revoked, password reset, refresh token expired) marks the
 *   connection NEEDS_ATTENTION and fails with PROVIDER_AUTH. FlowForge's own app credentials
 *   failing (`invalid_client`) is a server problem and leaves the connection alone.
 */
@Injectable()
export class MicrosoftTokenManager {
  constructor(
    private readonly credentials: CredentialStore,
    private readonly prisma: PrismaService,
    private readonly client: MicrosoftClient,
  ) {}

  async accessToken(
    workspaceId: string,
    connectionId: string,
    { rejectedToken }: { rejectedToken?: string } = {},
  ): Promise<string> {
    const current = usable(await this.credentials.get(workspaceId, connectionId));
    if (!rejectedToken && isFresh(current)) {
      await this.touch(connectionId);
      return current.accessToken!;
    }
    return this.refresh(workspaceId, connectionId, rejectedToken);
  }

  /**
   * Runs a Graph call with a valid token. A 401 forces one refresh and one retry (the token
   * may have been revoked early). A 403 flags the connection (permissions missing).
   *
   * A 401 *after a successful refresh* is not a consent problem — Microsoft just issued that
   * token (lost consent fails the refresh itself with invalid_grant). Graph does this when
   * the account cannot use the API at all, e.g. To Do for guest or unlicensed accounts without
   * an Exchange Online mailbox. That is reported as a permanent error and the connection is
   * left CONNECTED, since reconnecting would not help.
   */
  async withToken<T>(
    workspaceId: string,
    connectionId: string,
    call: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    const token = await this.accessToken(workspaceId, connectionId);
    try {
      return await call(token);
    } catch (err) {
      if (!(err instanceof GraphUnauthorizedError))
        throw await this.flagIfAuth(workspaceId, connectionId, err);
    }
    const refreshed = await this.accessToken(workspaceId, connectionId, { rejectedToken: token });
    try {
      return await call(refreshed);
    } catch (err) {
      if (err instanceof GraphUnauthorizedError) {
        throw new PermanentError(
          ErrorCategory.PERMANENT_PROVIDER_ERROR,
          `Microsoft Graph rejected a freshly issued token for this account: it probably cannot use Microsoft To Do (guest or unlicensed accounts without an Exchange Online mailbox). ${err.message}`,
        );
      }
      throw await this.flagIfAuth(workspaceId, connectionId, err);
    }
  }

  async markNeedsAttention(workspaceId: string, connectionId: string): Promise<void> {
    await this.prisma.integrationConnection.updateMany({
      where: { id: connectionId, workspaceId, provider: IntegrationProviderKey.MICROSOFT },
      data: { status: ConnectionStatus.NEEDS_ATTENTION },
    });
  }

  private async refresh(
    workspaceId: string,
    connectionId: string,
    rejectedToken?: string,
  ): Promise<string> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const locked = usable(await this.credentials.getLocked(tx, workspaceId, connectionId));
        // Someone refreshed while we waited for the lock: use their token.
        if (isFresh(locked) && locked.accessToken !== rejectedToken) return locked.accessToken!;

        const tokens = await this.client.refresh(locked.refreshToken);
        await this.credentials.save(
          connectionId,
          {
            accessToken: tokens.accessToken,
            // Microsoft usually rotates the refresh token; keep the old one if it did not.
            refreshToken: tokens.refreshToken ?? locked.refreshToken,
            accessTokenExpiresAt: tokens.expiresAt,
          },
          tx,
        );
        await tx.integrationConnection.update({
          where: { id: connectionId },
          data: { lastUsedAt: new Date() },
        });
        return tokens.accessToken;
      }, REFRESH_TX);
    } catch (err) {
      if (err instanceof MicrosoftConsentError)
        await this.markNeedsAttention(workspaceId, connectionId);
      throw err;
    }
  }

  /** Auth failures from Graph itself (401 after a refresh, 403) need the user to reconnect. */
  private async flagIfAuth(workspaceId: string, connectionId: string, err: unknown) {
    if (err instanceof ExecutionError && err.category === ErrorCategory.PROVIDER_AUTH) {
      await this.markNeedsAttention(workspaceId, connectionId);
    }
    return err;
  }

  private async touch(connectionId: string): Promise<void> {
    await this.prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { lastUsedAt: new Date() },
    });
  }
}

function usable(connection: DecryptedConnection | null): Usable {
  if (
    !connection ||
    connection.provider !== IntegrationProviderKey.MICROSOFT ||
    connection.status !== ConnectionStatus.CONNECTED ||
    !connection.refreshToken
  ) {
    throw new PermanentError(
      ErrorCategory.PROVIDER_AUTH,
      'The Microsoft connection is missing or needs attention; reconnect it',
    );
  }
  return connection as Usable;
}

const isFresh = (c: DecryptedConnection) =>
  Boolean(
    c.accessToken &&
    c.accessTokenExpiresAt &&
    c.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS,
  );
