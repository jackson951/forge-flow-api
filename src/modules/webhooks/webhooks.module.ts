import { Module } from '@nestjs/common';
import { GitHubWebhookProvider } from '../integrations/github/github-webhook.provider';
import { TestWebhookProvider } from './providers/test-webhook.provider';
import { WEBHOOK_PROVIDERS, WebhookProvider } from './providers/webhook-provider';
import { WebhookIntakeService } from './webhook-intake.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  controllers: [WebhooksController],
  providers: [
    TestWebhookProvider,
    GitHubWebhookProvider,
    {
      provide: WEBHOOK_PROVIDERS,
      inject: [TestWebhookProvider, GitHubWebhookProvider],
      useFactory: (...providers: WebhookProvider[]) => providers,
    },
    WebhookIntakeService,
  ],
})
export class WebhooksModule {}
