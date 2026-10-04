import { Injectable } from '@nestjs/common';
import { ConnectionStatusReason, ErrorCategory, IntegrationProviderKey } from '@prisma/client';
import { ExecutionError, PermanentError } from '../../../engine/errors';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { CredentialStore } from '../credentials/credential-store';
import { OAuthTokenManager, RefreshedTokens } from '../oauth/oauth-token-manager';
import { GraphUnauthorizedError, MicrosoftClient, MicrosoftConsentError } from './microsoft-client';

export { REFRESH_MARGIN_MS } from '../oauth/oauth-token-manager';

/**
 * Access tokens for Microsoft connections (delegated, per connecting user). The refresh,
 * locking and rotation rules live in OAuthTokenManager (shared with Jira since Part 25).
 *
 * `invalid_grant` (consent revoked, password reset, refresh token expired) marks the
 * connection NEEDS_ATTENTION and fails with PROVIDER_AUTH. FlowForge's own app credentials
 * failing (`invalid_client`) is a server problem and leaves the connection alone.
 */
@Injectable()
export class MicrosoftTokenManager extends OAuthTokenManager {
  protected readonly provider = IntegrationProviderKey.MICROSOFT;
  protected readonly label = 'Microsoft';

  constructor(
    credentials: CredentialStore,
    prisma: PrismaService,
    private readonly client: MicrosoftClient,
  ) {
    super(credentials, prisma);
  }

  protected refreshTokens(refreshToken: string): Promise<RefreshedTokens> {
    return this.client.refresh(refreshToken);
  }

  protected isConsentError(err: unknown): boolean {
    return err instanceof MicrosoftConsentError;
  }

  protected isUnauthorized(err: unknown): boolean {
    return err instanceof GraphUnauthorizedError;
  }

  /** 403 from Graph: permissions are missing. */
  protected authFailureReason(): ConnectionStatusReason {
    return ConnectionStatusReason.PERMISSION_CHANGED;
  }

  /**
   * A 401 *after a successful refresh* is not a consent problem — Microsoft just issued that
   * token (lost consent fails the refresh itself with invalid_grant). Graph does this when
   * the account cannot use the API at all, e.g. To Do for guest or unlicensed accounts without
   * an Exchange Online mailbox. That is reported as a permanent error and the connection is
   * left CONNECTED, since reconnecting would not help.
   */
  protected async freshTokenRejected(
    _workspaceId: string,
    _connectionId: string,
    err: ExecutionError,
  ): Promise<Error> {
    return new PermanentError(
      ErrorCategory.PERMANENT_PROVIDER_ERROR,
      `Microsoft Graph rejected a freshly issued token for this account: it probably cannot use Microsoft To Do (guest or unlicensed accounts without an Exchange Online mailbox). ${err.message}`,
    );
  }
}
