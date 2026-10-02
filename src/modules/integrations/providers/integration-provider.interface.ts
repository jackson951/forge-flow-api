import { IntegrationProviderKey } from '@prisma/client';
import { Credential } from '../credentials/credential-store';

/** What a provider learns when a connection is completed. Never contains secrets. */
export interface ConnectionDetails {
  /** Provider account id (GitHub installation id, Slack team id, Entra object id). */
  externalAccountId: string;
  accountLabel?: string;
  scopes: string[];
  metadata?: Record<string, string | number | boolean | null>;
}

/** Thrown by providers when the user may not connect this account (shown as a generic error). */
export class ConnectionDeniedError extends Error {
  constructor(
    readonly reason: 'denied' | 'not_authorized' | 'provider_error',
    message: string,
  ) {
    super(message);
    this.name = 'ConnectionDeniedError';
  }
}

/**
 * Connection flow of one provider. The shared IntegrationsService owns `state` creation and
 * single-use verification, membership checks, persistence and redirects; providers only
 * build the authorize URL and complete the provider-specific exchange.
 */
export interface IntegrationProvider {
  readonly key: IntegrationProviderKey;
  /** URL segment of the callback: /api/v1/integrations/<slug>/callback */
  readonly slug: string;
  isConfigured(): boolean;
  connectUrl(state: string): string;
  /** Called with the callback query after `state` was verified and consumed. */
  completeConnection(query: Record<string, string | undefined>): Promise<ConnectionDetails>;
  /** Best-effort revocation at the provider on disconnect (if the provider supports it). */
  revoke?(credential: Credential): Promise<void>;
}

export const INTEGRATION_PROVIDERS = Symbol('INTEGRATION_PROVIDERS');
