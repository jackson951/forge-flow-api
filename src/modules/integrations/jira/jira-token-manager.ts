import { Injectable } from '@nestjs/common';
import { ErrorCategory, IntegrationProviderKey } from '@prisma/client';
import { PermanentError } from '../../../engine/errors';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { CredentialStore } from '../credentials/credential-store';
import { OAuthTokenManager, RefreshedTokens } from '../oauth/oauth-token-manager';
import { JiraClient, JiraConsentError, JiraSite, JiraUnauthorizedError } from './jira-client';

/**
 * Access tokens for Jira connections (Part 25): Atlassian rotating refresh tokens, refreshed
 * under the shared lock (each refresh invalidates the previous refresh token, so the new one
 * is stored in the same transaction). A revoked or expired grant marks the connection
 * NEEDS_ATTENTION (TOKEN_REVOKED).
 */
@Injectable()
export class JiraTokenManager extends OAuthTokenManager {
  protected readonly provider = IntegrationProviderKey.JIRA;
  protected readonly label = 'Jira';

  constructor(
    credentials: CredentialStore,
    prisma: PrismaService,
    private readonly client: JiraClient,
  ) {
    super(credentials, prisma);
  }

  protected refreshTokens(refreshToken: string): Promise<RefreshedTokens> {
    return this.client.refresh(refreshToken);
  }

  protected isConsentError(err: unknown): boolean {
    return err instanceof JiraConsentError;
  }

  protected isUnauthorized(err: unknown): boolean {
    return err instanceof JiraUnauthorizedError;
  }

  /**
   * The Jira site `cloudId` must be one the connection's grant covers (recorded on connect /
   * site refresh). Anything else is refused before any call is made.
   */
  async site(workspaceId: string, connectionId: string, cloudId: string): Promise<JiraSite> {
    const connection = await this.prisma.integrationConnection.findFirst({
      where: { id: connectionId, workspaceId, provider: IntegrationProviderKey.JIRA },
      select: { metadata: true },
    });
    const sites = jiraSites(connection?.metadata);
    const site = sites.find((s) => s.cloudId === cloudId);
    if (!site) {
      throw new PermanentError(
        ErrorCategory.VALIDATION,
        'This Jira site is not part of the connection; reconnect Jira or pick another site',
      );
    }
    return site;
  }
}

/** The sites stored on a Jira connection's metadata. */
export function jiraSites(metadata: unknown): JiraSite[] {
  const sites = (metadata as { sites?: unknown } | null)?.sites;
  return Array.isArray(sites)
    ? sites.filter(
        (s): s is JiraSite =>
          !!s && typeof s === 'object' && typeof (s as JiraSite).cloudId === 'string',
      )
    : [];
}
