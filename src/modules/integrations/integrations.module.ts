import { Module } from '@nestjs/common';
import { CredentialStore } from './credentials/credential-store';
import { GitHubClient } from './github/github-client';
import { MicrosoftClient } from './microsoft/microsoft-client';
import { MicrosoftTokenManager } from './microsoft/microsoft-token-manager';
import { JiraClient } from './jira/jira-client';
import { JiraTokenManager } from './jira/jira-token-manager';
import { JiraProvider } from './providers/jira.provider';
import { GmailClient } from './gmail/gmail-client';
import { GmailTokenManager } from './gmail/gmail-token-manager';
import { GmailProvider } from './providers/gmail.provider';
import { SlackClient } from './slack/slack-client';
import { IntegrationProvidersController, IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { HttpConnectionsService } from './http/http-connections.service';
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
    JiraClient,
    JiraTokenManager,
    GmailClient,
    GmailTokenManager,
    GitHubProvider,
    MicrosoftProvider,
    SlackProvider,
    JiraProvider,
    GmailProvider,
    {
      provide: INTEGRATION_PROVIDERS,
      inject: [GitHubProvider, MicrosoftProvider, SlackProvider, JiraProvider, GmailProvider],
      useFactory: (...providers: IntegrationProvider[]) => providers,
    },
    IntegrationsService,
    HttpConnectionsService,
  ],
  exports: [IntegrationsService, GitHubClient, SlackClient, CredentialStore],
})
export class IntegrationsModule {}
