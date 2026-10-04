import { Injectable } from '@nestjs/common';
import { IntegrationProviderKey } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ExecutionError } from '../../../engine/errors';
import { EncryptionService } from '../../../infrastructure/crypto/encryption.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { Credential } from '../credentials/credential-store';
import { GMAIL_SCOPES, GmailClient } from '../gmail/gmail-client';
import { GmailTokenManager } from '../gmail/gmail-token-manager';
import {
  CompletedConnection,
  ConnectionDeniedError,
  IntegrationProvider,
} from './integration-provider.interface';

/**
 * Gmail via Google OAuth 2.0, authorization code + PKCE, `access_type=offline` and
 * `prompt=consent` so Google returns a refresh token (Part 26, FR-26.1). One connection per
 * mailbox (externalAccountId = Google user id `sub`, label = the address). Disconnect stops the
 * mailbox watch (unless another connection still needs it) and revokes the refresh token.
 */
@Injectable()
export class GmailProvider implements IntegrationProvider {
  readonly key = IntegrationProviderKey.GMAIL;
  readonly slug = 'gmail';
  readonly usesPkce = true;

  constructor(
    private readonly gmail: GmailClient,
    private readonly tokens: GmailTokenManager,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GmailProvider.name);
  }

  isConfigured(): boolean {
    return this.gmail.isConfigured() && this.encryption.isConfigured();
  }

  connectUrl(state: string, pkce?: { codeChallenge: string }): string {
    if (!pkce) throw new Error('Gmail connections require PKCE');
    return this.gmail.authorizeUrl(state, pkce.codeChallenge);
  }

  async completeConnection(
    query: Record<string, string | undefined>,
    context?: { codeVerifier?: string },
  ): Promise<CompletedConnection> {
    if (!query.code || !context?.codeVerifier) {
      throw new ConnectionDeniedError('denied', 'Google authorization was not completed');
    }
    try {
      const tokens = await this.gmail.exchangeCode(query.code, context.codeVerifier);
      const granted = new Set(tokens.scopes);
      const missing = GMAIL_SCOPES.filter((s) => s.startsWith('https://') && !granted.has(s));
      if (missing.length || !tokens.refreshToken) {
        // Google's consent screen lets users untick scopes ("granular consent").
        throw new ConnectionDeniedError(
          'not_authorized',
          `Google did not grant ${missing.length ? missing.map((s) => s.split('/').pop()).join(', ') : 'offline access'}`,
        );
      }
      const user = await this.gmail.userinfo(tokens.accessToken);
      if (!user.emailVerified)
        throw new ConnectionDeniedError(
          'not_authorized',
          'The Google account email is not verified',
        );
      return {
        externalAccountId: user.sub,
        accountLabel: user.email,
        scopes: tokens.scopes,
        metadata: { emailAddress: user.email },
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

  /**
   * Stops the mailbox watch before the tokens go — but only when no other connection (e.g.
   * another workspace) still watches the same mailbox: Gmail keeps one watch per user and
   * topic, so `users.stop` would silence it for everyone.
   */
  async beforeDisconnect(connection: { id: string; workspaceId: string }): Promise<void> {
    const sub = await this.prisma.providerSubscription.findFirst({
      where: { connectionId: connection.id, provider: IntegrationProviderKey.GMAIL },
      include: { connection: { select: { accountLabel: true } } },
    });
    if (!sub) return;
    const others = await this.prisma.providerSubscription.count({
      where: {
        provider: IntegrationProviderKey.GMAIL,
        connectionId: { not: connection.id },
        connection: { accountLabel: sub.connection.accountLabel },
      },
    });
    if (others) return;
    try {
      await this.tokens.withToken(connection.workspaceId, connection.id, (token) =>
        this.gmail.stop(token),
      );
    } catch (err) {
      this.logger.warn(
        { connectionId: connection.id, error: (err as Error).message },
        'Could not stop the Gmail watch on disconnect; it expires within 7 days',
      );
    }
  }

  /** Revokes the refresh token at Google (best effort). */
  async revoke(credential: Credential): Promise<void> {
    const token = credential.refreshToken ?? credential.accessToken;
    if (token) await this.gmail.revoke(token);
  }
}
