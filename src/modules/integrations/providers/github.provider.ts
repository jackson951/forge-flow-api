import { Injectable } from '@nestjs/common';
import { IntegrationProviderKey } from '@prisma/client';
import { ExecutionError } from '../../../engine/errors';
import { GitHubClient } from '../github/github-client';
import {
  ConnectionDeniedError,
  ConnectionDetails,
  IntegrationProvider,
} from './integration-provider.interface';

/**
 * GitHub App connection. The browser goes to the app's install page; with "Request user
 * authorization (OAuth) during installation" enabled, GitHub redirects back with
 * `installation_id`, `setup_action` and a user `code`. The code is exchanged once to prove the
 * user can access that installation, then discarded: FlowForge stores no GitHub tokens, only
 * the installation id. API calls use short-lived installation tokens minted from the app key.
 */
@Injectable()
export class GitHubProvider implements IntegrationProvider {
  readonly key = IntegrationProviderKey.GITHUB;
  readonly slug = 'github';

  constructor(private readonly github: GitHubClient) {}

  isConfigured(): boolean {
    return this.github.isConfigured();
  }

  connectUrl(state: string): string {
    return this.github.installUrl(state);
  }

  async completeConnection(query: Record<string, string | undefined>): Promise<ConnectionDetails> {
    const installationId = Number(query.installation_id);
    if (!query.code || !Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new ConnectionDeniedError('denied', 'Installation was not completed');
    }
    try {
      const userToken = await this.github.exchangeUserCode(query.code);
      const accessible = await this.github.userInstallationIds(userToken);
      if (!accessible.has(installationId)) {
        throw new ConnectionDeniedError(
          'not_authorized',
          'The authorizing user cannot access this installation',
        );
      }
      const installation = await this.github.getInstallation(installationId);
      return {
        externalAccountId: String(installationId),
        accountLabel: installation.account.login,
        scopes: [],
        metadata: {
          accountType: installation.account.type,
          repositorySelection: installation.repository_selection ?? null,
        },
      };
    } catch (err) {
      if (err instanceof ConnectionDeniedError) throw err;
      if (err instanceof ExecutionError) {
        throw new ConnectionDeniedError('provider_error', err.message);
      }
      throw err;
    }
  }
}
