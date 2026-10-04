import { Injectable } from '@nestjs/common';
import { ConnectionStatusReason, IntegrationProviderKey } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { CredentialStore } from '../credentials/credential-store';
import { OAuthTokenManager, RefreshedTokens } from '../oauth/oauth-token-manager';
import { GmailClient, GmailConsentError, GmailUnauthorizedError } from './gmail-client';

/**
 * Access tokens for Gmail connections (Part 26), through the shared locked refresh (Part 25).
 * `invalid_grant` → NEEDS_ATTENTION (TOKEN_REVOKED); a 403 for missing permissions →
 * NEEDS_ATTENTION (PERMISSION_CHANGED).
 */
@Injectable()
export class GmailTokenManager extends OAuthTokenManager {
  protected readonly provider = IntegrationProviderKey.GMAIL;
  protected readonly label = 'Gmail';

  constructor(
    credentials: CredentialStore,
    prisma: PrismaService,
    private readonly client: GmailClient,
  ) {
    super(credentials, prisma);
  }

  protected refreshTokens(refreshToken: string): Promise<RefreshedTokens> {
    return this.client.refresh(refreshToken);
  }

  protected isConsentError(err: unknown): boolean {
    return err instanceof GmailConsentError;
  }

  protected isUnauthorized(err: unknown): boolean {
    return err instanceof GmailUnauthorizedError;
  }

  protected authFailureReason(): ConnectionStatusReason {
    return ConnectionStatusReason.PERMISSION_CHANGED;
  }

  /** The mailbox address of a connection (From of every email it sends). */
  async mailbox(workspaceId: string, connectionId: string): Promise<string> {
    const connection = await this.prisma.integrationConnection.findFirst({
      where: { id: connectionId, workspaceId, provider: IntegrationProviderKey.GMAIL },
      select: { accountLabel: true },
    });
    return connection?.accountLabel ?? '';
  }
}
