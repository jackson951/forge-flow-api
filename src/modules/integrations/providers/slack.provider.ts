import { Injectable } from '@nestjs/common';
import { IntegrationProviderKey } from '@prisma/client';
import { ExecutionError } from '../../../engine/errors';
import { EncryptionService } from '../../../infrastructure/crypto/encryption.service';
import type { Credential } from '../credentials/credential-store';
import { SlackClient } from '../slack/slack-client';
import {
  CompletedConnection,
  ConnectionDeniedError,
  IntegrationProvider,
} from './integration-provider.interface';

/**
 * Slack OAuth v2 (bot token). The callback code is exchanged for a bot token, which is
 * stored encrypted with the connection (Part 17) and used only by the worker's
 * `slack.sendMessage` handler and the channel listing. Re-connecting the same Slack team in
 * the same workspace updates the existing connection and replaces the token.
 */
@Injectable()
export class SlackProvider implements IntegrationProvider {
  readonly key = IntegrationProviderKey.SLACK;
  readonly slug = 'slack';

  constructor(
    private readonly slack: SlackClient,
    private readonly encryption: EncryptionService,
  ) {}

  /** Needs OAuth settings and credential encryption (tokens are never stored in plaintext). */
  isConfigured(): boolean {
    return this.slack.isConfigured() && this.encryption.isConfigured();
  }

  connectUrl(state: string): string {
    return this.slack.authorizeUrl(state);
  }

  async completeConnection(
    query: Record<string, string | undefined>,
  ): Promise<CompletedConnection> {
    if (!query.code)
      throw new ConnectionDeniedError('denied', 'Slack authorization was not completed');
    try {
      const result = await this.slack.exchangeCode(query.code);
      return {
        externalAccountId: result.teamId,
        accountLabel: result.teamName,
        scopes: result.scopes,
        metadata: { teamId: result.teamId, botUserId: result.botUserId },
        credential: { accessToken: result.accessToken },
      };
    } catch (err) {
      if (err instanceof ExecutionError) {
        throw new ConnectionDeniedError('provider_error', err.message);
      }
      throw err;
    }
  }

  async revoke(credential: Credential): Promise<void> {
    if (credential.accessToken) await this.slack.revoke(credential.accessToken);
  }
}
