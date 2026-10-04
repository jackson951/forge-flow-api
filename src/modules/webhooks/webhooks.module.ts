import { Module } from '@nestjs/common';
import { GitHubWebhookProvider } from '../integrations/github/github-webhook.provider';
import { JiraWebhookProvider } from '../integrations/jira/jira-webhook.provider';
import { GmailPushProvider } from '../integrations/gmail/gmail-push.provider';
import { GoogleOidcVerifier } from '../integrations/gmail/google-oidc-verifier';
import { TestWebhookProvider } from './providers/test-webhook.provider';
import { WEBHOOK_PROVIDERS, WebhookProvider } from './providers/webhook-provider';
import { WebhookIntakeService } from './webhook-intake.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  controllers: [WebhooksController],
  providers: [
    TestWebhookProvider,
    GitHubWebhookProvider,
    JiraWebhookProvider,
    GoogleOidcVerifier,
    GmailPushProvider,
    {
      provide: WEBHOOK_PROVIDERS,
      inject: [TestWebhookProvider, GitHubWebhookProvider, JiraWebhookProvider, GmailPushProvider],
      useFactory: (...providers: WebhookProvider[]) => providers,
    },
    WebhookIntakeService,
  ],
})
export class WebhooksModule {}
