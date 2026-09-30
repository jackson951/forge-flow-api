import { Injectable, NotImplementedException } from '@nestjs/common';
import { IntegrationProviderKey } from '@prisma/client';

export interface InboundWebhook {
  provider: IntegrationProviderKey;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer | undefined;
  body: unknown;
}

/**
 * verify signature → dedupe on delivery ID → persist WebhookEvent → enqueue run.
 * Must acknowledge quickly; no third-party calls inline.
 */
@Injectable()
export class WebhooksService {
  receive(_webhook: InboundWebhook): Promise<{ accepted: boolean }> {
    throw new NotImplementedException();
  }
}
