import { Injectable, NotImplementedException } from '@nestjs/common';
import { IntegrationProviderKey } from '@prisma/client';
import { ConnectionDetails, IntegrationProvider } from './integration-provider.interface';

/** Slack connection — implemented in Part 13. Reports itself as not configured until then. */
@Injectable()
export class SlackProvider implements IntegrationProvider {
  readonly key = IntegrationProviderKey.SLACK;
  readonly slug = 'slack';

  isConfigured(): boolean {
    return false;
  }

  connectUrl(): string {
    throw new NotImplementedException();
  }

  completeConnection(): Promise<ConnectionDetails> {
    throw new NotImplementedException();
  }
}
