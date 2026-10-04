import {
  ConnectionStatus,
  ConnectionStatusReason,
  ErrorCategory,
  IntegrationProviderKey,
} from '@prisma/client';
import { ExecutionError, PermanentError } from '../../../engine/errors';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { CredentialStore, DecryptedConnection } from '../credentials/credential-store';

/** Refresh when the access token expires within this window (FR-14.3). */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/** Row lock wait + one token request must fit; generous to absorb a queued refresh. */
const REFRESH_TX = { maxWait: 10_000, timeout: 45_000 };

export interface RefreshedTokens {
  accessToken: string;
  /** Absent when the provider did not rotate it (keep the old one). */
  refreshToken?: string;
  expiresAt: Date;
}

type Usable = DecryptedConnection & { refreshToken: string };

/**
 * Access tokens for OAuth connections that act with a stored, refreshable user token
 * (Microsoft since Part 14; Jira Part 25; Gmail Part 26). One implementation of the rules:
 *
 * - tokens are refreshed shortly before expiry; refreshes of one connection are serialised
 *   with a row lock on its credential (across API and worker processes) — whoever gets the
 *   lock second re-reads and uses the token the first one stored;
 * - a rotated refresh token is saved in the same transaction as the new access token
 *   (providers with rotating refresh tokens invalidate the old one);
 * - a refresh rejected as revoked / expired consent marks the connection NEEDS_ATTENTION
 *   (TOKEN_REVOKED) and fails with PROVIDER_AUTH; the app's own credentials failing is a
 *   server problem and leaves the connection alone;
 * - a 401 from the API forces one refresh and one retry.
 *
 * Subclasses provide the provider: how to refresh, and how its errors look.
 */
export abstract class OAuthTokenManager {
  protected abstract readonly provider: IntegrationProviderKey;
  protected abstract readonly label: string;

  constructor(
    protected readonly credentials: CredentialStore,
    protected readonly prisma: PrismaService,
  ) {}

  /** The provider's token endpoint (refresh_token grant). */
  protected abstract refreshTokens(refreshToken: string): Promise<RefreshedTokens>;
  /** The refresh failed because the user's grant no longer works (reconnect needed). */
  protected abstract isConsentError(err: unknown): boolean;
  /** The API rejected the access token (401): worth one forced refresh. */
  protected abstract isUnauthorized(err: unknown): boolean;

  /**
   * A token issued moments ago was rejected again. Default: the user has to reconnect.
   * Microsoft overrides this (Graph does it for accounts that cannot use To Do at all).
   */
  protected async freshTokenRejected(
    workspaceId: string,
    connectionId: string,
    err: ExecutionError,
  ): Promise<Error> {
    await this.markNeedsAttention(
      workspaceId,
      connectionId,
      ConnectionStatusReason.AUTHENTICATION_FAILED,
    );
    return new PermanentError(
      ErrorCategory.PROVIDER_AUTH,
      `${this.label} rejected a freshly issued token; reconnect ${this.label}. ${err.message}`,
    );
  }

  /** Reason recorded when an API call fails with PROVIDER_AUTH (after the refresh/retry). */
  protected authFailureReason(_err: ExecutionError): ConnectionStatusReason {
    return ConnectionStatusReason.AUTHENTICATION_FAILED;
  }

  async accessToken(
    workspaceId: string,
    connectionId: string,
    { rejectedToken }: { rejectedToken?: string } = {},
  ): Promise<string> {
    const current = this.usable(await this.credentials.get(workspaceId, connectionId));
    if (!rejectedToken && isFresh(current)) {
      await this.touch(connectionId);
      return current.accessToken!;
    }
    return this.refresh(workspaceId, connectionId, rejectedToken);
  }

  /** Runs an API call with a valid token; a 401 forces one refresh and one retry. */
  async withToken<T>(
    workspaceId: string,
    connectionId: string,
    call: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    const token = await this.accessToken(workspaceId, connectionId);
    try {
      return await call(token);
    } catch (err) {
      if (!this.isUnauthorized(err)) throw await this.flagIfAuth(workspaceId, connectionId, err);
    }
    const refreshed = await this.accessToken(workspaceId, connectionId, { rejectedToken: token });
    try {
      return await call(refreshed);
    } catch (err) {
      if (this.isUnauthorized(err)) {
        throw await this.freshTokenRejected(workspaceId, connectionId, err as ExecutionError);
      }
      throw await this.flagIfAuth(workspaceId, connectionId, err);
    }
  }

  async markNeedsAttention(
    workspaceId: string,
    connectionId: string,
    reason: ConnectionStatusReason = ConnectionStatusReason.AUTHENTICATION_FAILED,
  ): Promise<void> {
    await this.prisma.integrationConnection.updateMany({
      where: { id: connectionId, workspaceId, provider: this.provider },
      data: { status: ConnectionStatus.NEEDS_ATTENTION, statusReason: reason },
    });
  }

  private async refresh(
    workspaceId: string,
    connectionId: string,
    rejectedToken?: string,
  ): Promise<string> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const locked = this.usable(await this.credentials.getLocked(tx, workspaceId, connectionId));
        // Someone refreshed while we waited for the lock: use their token.
        if (isFresh(locked) && locked.accessToken !== rejectedToken) return locked.accessToken!;

        const tokens = await this.refreshTokens(locked.refreshToken);
        await this.credentials.save(
          connectionId,
          {
            accessToken: tokens.accessToken,
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
      if (this.isConsentError(err)) {
        await this.markNeedsAttention(
          workspaceId,
          connectionId,
          ConnectionStatusReason.TOKEN_REVOKED,
        );
      }
      throw err;
    }
  }

  /** Auth failures from the API itself (401 after a refresh, 403) need the user to reconnect. */
  private async flagIfAuth(workspaceId: string, connectionId: string, err: unknown) {
    if (err instanceof ExecutionError && err.category === ErrorCategory.PROVIDER_AUTH) {
      await this.markNeedsAttention(workspaceId, connectionId, this.authFailureReason(err));
    }
    return err;
  }

  private async touch(connectionId: string): Promise<void> {
    await this.prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { lastUsedAt: new Date() },
    });
  }

  private usable(connection: DecryptedConnection | null): Usable {
    // A failed webhook renewal flags the connection but its tokens still work (and renewal
    // must be able to retry and heal it).
    const usableStatus =
      connection?.status === ConnectionStatus.CONNECTED ||
      (connection?.status === ConnectionStatus.NEEDS_ATTENTION &&
        connection.statusReason === ConnectionStatusReason.WATCH_RENEWAL_FAILED);
    if (
      !connection ||
      connection.provider !== this.provider ||
      !usableStatus ||
      !connection.refreshToken
    ) {
      throw new PermanentError(
        ErrorCategory.PROVIDER_AUTH,
        `The ${this.label} connection is missing or needs attention; reconnect it`,
      );
    }
    return connection as Usable;
  }
}

const isFresh = (c: DecryptedConnection) =>
  Boolean(
    c.accessToken &&
    c.accessTokenExpiresAt &&
    c.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS,
  );
