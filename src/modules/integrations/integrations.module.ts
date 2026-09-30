import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { GitHubProvider } from './providers/github.provider';
import { INTEGRATION_PROVIDERS } from './providers/integration-provider.interface';
import { MicrosoftProvider } from './providers/microsoft.provider';
import { SlackProvider } from './providers/slack.provider';

@Module({
  controllers: [IntegrationsController],
  providers: [
    GitHubProvider,
    MicrosoftProvider,
    SlackProvider,
    {
      provide: INTEGRATION_PROVIDERS,
      inject: [GitHubProvider, MicrosoftProvider, SlackProvider],
      useFactory: (...providers: [GitHubProvider, MicrosoftProvider, SlackProvider]) => providers,
    },
    IntegrationsService,
  ],
  exports: [IntegrationsService, INTEGRATION_PROVIDERS],
})
export class IntegrationsModule {}
