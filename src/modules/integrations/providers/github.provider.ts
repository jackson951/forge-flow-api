import { Injectable, NotImplementedException } from '@nestjs/common';
import { IntegrationProviderKey } from '@prisma/client';
import { IntegrationProvider, OAuthTokens } from './integration-provider.interface';

@Injectable()
export class GitHubProvider implements IntegrationProvider {
  readonly key = IntegrationProviderKey.GITHUB;

  buildAuthorizationUrl(_state: string): string {
    throw new NotImplementedException();
  }

  exchangeCode(_code: string): Promise<OAuthTokens> {
    throw new NotImplementedException();
  }

  refresh(_refreshToken: string): Promise<OAuthTokens> {
    throw new NotImplementedException();
  }
}
