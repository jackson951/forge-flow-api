import { Injectable } from '@nestjs/common';
import { IntegrationProviderKey } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ExecutionError } from '../../../engine/errors';
import { EncryptionService } from '../../../infrastructure/crypto/encryption.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { JIRA_SCOPES, JiraClient } from '../jira/jira-client';
import { JiraTokenManager } from '../jira/jira-token-manager';
import {
  CompletedConnection,
  ConnectionDeniedError,
  IntegrationProvider,
} from './integration-provider.interface';

/**
 * Jira Cloud, Atlassian OAuth 2.0 (3LO) authorization code flow (Part 25). PKCE is not part of
 * Atlassian's documented 3LO flow, so the single-use `state` is the CSRF protection.
 *
 * One connection per Atlassian grant (externalAccountId = Atlassian account id). The grant's
 * Jira sites are recorded on the connection; every Jira node chooses a site (`siteId`). One
 * connection per site would store several copies of one rotating refresh token, and refreshing
 * any copy would invalidate the others.
 *
 * Atlassian documents no token revocation endpoint: disconnecting deletes the tokens and the
 * dynamic webhooks; users remove the grant under "Connected apps" in their Atlassian account.
 */
@Injectable()
export class JiraProvider implements IntegrationProvider {
  readonly key = IntegrationProviderKey.JIRA;
  readonly slug = 'jira';

  constructor(
    private readonly jira: JiraClient,
    private readonly tokens: JiraTokenManager,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(JiraProvider.name);
  }

  isConfigured(): boolean {
    return this.jira.isConfigured() && this.encryption.isConfigured();
  }

  connectUrl(state: string): string {
    return this.jira.authorizeUrl(state);
  }

  async completeConnection(
    query: Record<string, string | undefined>,
  ): Promise<CompletedConnection> {
    if (!query.code)
      throw new ConnectionDeniedError('denied', 'Jira authorization was not completed');
    try {
      const tokens = await this.jira.exchangeCode(query.code);
      const granted = new Set(tokens.scopes);
      const missing = JIRA_SCOPES.filter((s) => !granted.has(s));
      if (missing.length || !tokens.refreshToken) {
        throw new ConnectionDeniedError(
          'not_authorized',
          `Atlassian did not grant the required scopes (${missing.join(', ') || 'offline_access'})`,
        );
      }
      const [account, sites] = await Promise.all([
        this.jira.me(tokens.accessToken),
        this.jira.sites(tokens.accessToken),
      ]);
      if (!sites.length) {
        throw new ConnectionDeniedError('not_authorized', 'The grant does not include a Jira site');
      }
      return {
        externalAccountId: account.accountId,
        accountLabel: account.email ?? account.name ?? account.accountId,
        scopes: tokens.scopes,
        metadata: { accountName: account.name, sites },
        credential: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accessTokenExpiresAt: tokens.expiresAt,
        },
      };
    } catch (err) {
      if (err instanceof ConnectionDeniedError) throw err;
      if (err instanceof ExecutionError)
        throw new ConnectionDeniedError('provider_error', err.message);
      throw err;
    }
  }

  /** Best effort: remove the connection's dynamic webhooks before its tokens are deleted. */
  async beforeDisconnect(connection: { id: string; workspaceId: string }): Promise<void> {
    const subscriptions = await this.prisma.providerSubscription.findMany({
      where: { connectionId: connection.id, provider: IntegrationProviderKey.JIRA },
      select: { resourceKey: true, externalIds: true },
    });
    for (const sub of subscriptions) {
      if (!sub.externalIds.length) continue;
      try {
        await this.tokens.withToken(connection.workspaceId, connection.id, (token) =>
          this.jira.deleteWebhooks(token, sub.resourceKey, sub.externalIds),
        );
      } catch (err) {
        this.logger.warn(
          { connectionId: connection.id, cloudId: sub.resourceKey, error: (err as Error).message },
          'Could not delete Jira webhooks on disconnect; they expire within 30 days',
        );
      }
    }
  }
}
