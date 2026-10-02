import { Injectable, NotImplementedException } from '@nestjs/common';
import { IntegrationProviderKey } from '@prisma/client';
import { ConnectionDetails, IntegrationProvider } from './integration-provider.interface';

/** Microsoft connection — implemented in Part 14. Reports itself as not configured until then. */
@Injectable()
export class MicrosoftProvider implements IntegrationProvider {
  readonly key = IntegrationProviderKey.MICROSOFT;
  readonly slug = 'microsoft';

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
