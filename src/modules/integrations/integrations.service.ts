import { Inject, Injectable, NotImplementedException } from '@nestjs/common';
import { IntegrationProviderKey } from '@prisma/client';
import { OAuthCallbackQueryDto } from './dto/oauth-callback-query.dto';
import {
  INTEGRATION_PROVIDERS,
  IntegrationProvider,
} from './providers/integration-provider.interface';

@Injectable()
export class IntegrationsService {
  constructor(
    @Inject(INTEGRATION_PROVIDERS)
    private readonly providers: IntegrationProvider[],
  ) {}

  listProviders(): IntegrationProviderKey[] {
    return this.providers.map((p) => p.key);
  }

  listConnections(_workspaceId: string): Promise<unknown> {
    throw new NotImplementedException();
  }

  startConnect(_workspaceId: string, _provider: IntegrationProviderKey): Promise<{ url: string }> {
    throw new NotImplementedException();
  }

  handleCallback(
    _provider: IntegrationProviderKey,
    _query: OAuthCallbackQueryDto,
  ): Promise<unknown> {
    throw new NotImplementedException();
  }

  disconnect(_workspaceId: string, _connectionId: string): Promise<void> {
    throw new NotImplementedException();
  }
}
