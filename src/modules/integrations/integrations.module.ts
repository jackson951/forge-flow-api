import { Module } from '@nestjs/common';
import { CredentialStore } from './credentials/credential-store';
import { GitHubClient } from './github/github-client';
import { MicrosoftClient } from './microsoft/microsoft-client';
import { MicrosoftTokenManager } from './microsoft/microsoft-token-manager';
import { SlackClient } from './slack/slack-client';
import { IntegrationProvidersController, IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { GitHubProvider } from './providers/github.provider';
import {
  INTEGRATION_PROVIDERS,
  IntegrationProvider,
} from './providers/integration-provider.interface';
import { MicrosoftProvider } from './providers/microsoft.provider';
import { SlackProvider } from './providers/slack.provider';

@Module({
  controllers: [IntegrationsController, IntegrationProvidersController],
  providers: [
    CredentialStore,
    GitHubClient,
    SlackClient,
    MicrosoftClient,
    MicrosoftTokenManager,
    GitHubProvider,
    MicrosoftProvider,
    SlackProvider,
    {
      provide: INTEGRATION_PROVIDERS,
      inject: [GitHubProvider, MicrosoftProvider, SlackProvider],
      useFactory: (...providers: IntegrationProvider[]) => providers,
    },
    IntegrationsService,
  ],
  exports: [IntegrationsService, GitHubClient, SlackClient, CredentialStore],
})
export class IntegrationsModule {}
