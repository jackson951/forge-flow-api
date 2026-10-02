import { Injectable } from '@nestjs/common';
import { IntegrationProviderKey } from '@prisma/client';
import { ExecutionError } from '../../../engine/errors';
import { EncryptionService } from '../../../infrastructure/crypto/encryption.service';
import { idTokenClaims, MicrosoftClient } from '../microsoft/microsoft-client';
import {
  CompletedConnection,
  ConnectionDeniedError,
  IntegrationProvider,
} from './integration-provider.interface';

/** Graph returns scopes either bare ("Tasks.ReadWrite") or as resource URIs. */
const normaliseScope = (scope: string) => scope.replace(/^https:\/\/graph\.microsoft\.com\//i, '');

/**
 * Microsoft Entra ID, authorization code + PKCE with delegated permissions. Workflows using
 * the connection act as the connecting user. Access and refresh tokens are stored encrypted;
 * MicrosoftTokenManager refreshes them. The id_token is read for display metadata only.
 *
 * There is no per-app token revocation endpoint for delegated tokens, so disconnecting
 * deletes the tokens in FlowForge; users remove the consent itself in their Microsoft account
 * (https://myapps.microsoft.com or https://account.live.com/consent/Manage).
 */
@Injectable()
export class MicrosoftProvider implements IntegrationProvider {
  readonly key = IntegrationProviderKey.MICROSOFT;
  readonly slug = 'microsoft';
  readonly usesPkce = true;

  constructor(
    private readonly microsoft: MicrosoftClient,
    private readonly encryption: EncryptionService,
  ) {}

  /** Needs the app registration and credential encryption (PKCE verifier, tokens). */
  isConfigured(): boolean {
    return this.microsoft.isConfigured() && this.encryption.isConfigured();
  }

  connectUrl(state: string, pkce?: { codeChallenge: string }): string {
    if (!pkce) throw new Error('Microsoft connections require PKCE');
    return this.microsoft.authorizeUrl(state, pkce.codeChallenge);
  }

  async completeConnection(
    query: Record<string, string | undefined>,
    context?: { codeVerifier?: string },
  ): Promise<CompletedConnection> {
    if (!query.code || !context?.codeVerifier) {
      throw new ConnectionDeniedError('denied', 'Microsoft authorization was not completed');
    }
    try {
      const tokens = await this.microsoft.exchangeCode(query.code, context.codeVerifier);
      const scopes = tokens.scopes.map(normaliseScope);
      const granted = new Set(scopes.map((s) => s.toLowerCase()));
      if (!granted.has('tasks.readwrite') || !tokens.refreshToken) {
        // Consent was partial (e.g. the tenant blocks Tasks.ReadWrite or offline access).
        throw new ConnectionDeniedError(
          'not_authorized',
          'Microsoft did not grant Tasks.ReadWrite with offline access',
        );
      }
      const profile = await this.microsoft.me(tokens.accessToken);
      return {
        // From Graph (authenticated by the token), not from the unverified id_token.
        externalAccountId: profile.id,
        accountLabel:
          profile.userPrincipalName ?? profile.mail ?? profile.displayName ?? profile.id,
        scopes,
        metadata: {
          displayName: profile.displayName,
          userPrincipalName: profile.userPrincipalName,
          tenantId: idTokenClaims(tokens.idToken).tenantId ?? null,
        },
        credential: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accessTokenExpiresAt: tokens.expiresAt,
        },
      };
    } catch (err) {
      if (err instanceof ConnectionDeniedError) throw err;
      if (err instanceof ExecutionError) {
        throw new ConnectionDeniedError('provider_error', err.message);
      }
      throw err;
    }
  }
}
