import { IntegrationProviderKey } from '@prisma/client';

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
}

/**
 * Common contract that hides provider-specific APIs from the rest of the system.
 * GitHub, Microsoft Graph and Slack each implement this.
 */
export interface IntegrationProvider {
  readonly key: IntegrationProviderKey;
  buildAuthorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
}

export const INTEGRATION_PROVIDERS = Symbol('INTEGRATION_PROVIDERS');
