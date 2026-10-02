import { Injectable } from '@nestjs/common';
import { ConnectionStatus, IntegrationProviderKey } from '@prisma/client';
import { AppConfigService } from '../../../config/app-config.service';
import {
  header,
  hmacSha256Matches,
  InboundWebhook,
  NormalizedEvent,
  VerificationResult,
  WebhookProvider,
} from '../../webhooks/providers/webhook-provider';

const MAX_BODY_CHARS = 10_000;

interface GitHubIssuesPayload {
  action?: string;
  installation?: { id?: number };
  repository?: { full_name?: string; private?: boolean };
  sender?: { login?: string; type?: string };
  issue?: {
    number?: number;
    title?: string;
    body?: string | null;
    html_url?: string;
    state?: string;
    created_at?: string;
    labels?: ({ name?: string } | string)[];
    user?: { login?: string; type?: string };
  };
}

/**
 * GitHub App webhooks: `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app's
 * webhook secret), `X-GitHub-Delivery` (unique per delivery; GitHub redeliveries reuse it, so
 * it is the dedup key), `X-GitHub-Event` + `action`.
 *
 * Acts on `issues.opened`; `installation` deleted/suspend/unsuspend update connection status;
 * everything else is stored as IGNORED.
 */
@Injectable()
export class GitHubWebhookProvider implements WebhookProvider {
  readonly slug = 'github';
  readonly key = IntegrationProviderKey.GITHUB;

  constructor(private readonly config: AppConfigService) {}

  isEnabled(): boolean {
    return Boolean(this.config.get('GITHUB_WEBHOOK_SECRET'));
  }

  verify(request: InboundWebhook): VerificationResult {
    const valid = hmacSha256Matches(
      this.config.get('GITHUB_WEBHOOK_SECRET')!,
      request.rawBody,
      header(request, 'x-hub-signature-256'),
    );
    return valid ? { ok: true } : { ok: false, reason: 'signature mismatch' };
  }

  deliveryId(request: InboundWebhook): string | undefined {
    return header(request, 'x-github-delivery');
  }

  eventName(request: InboundWebhook): string {
    const action = (request.body as { action?: unknown } | null)?.action;
    const event = header(request, 'x-github-event') ?? 'unknown';
    return typeof action === 'string' ? `${event}.${action}` : event;
  }

  normalize(request: InboundWebhook): NormalizedEvent | null {
    const event = header(request, 'x-github-event');
    const payload = (request.body ?? {}) as GitHubIssuesPayload;
    const installationId = payload.installation?.id;
    if (typeof installationId !== 'number') return null;

    if (event === 'installation') {
      const status =
        payload.action === 'deleted'
          ? ConnectionStatus.DISCONNECTED
          : payload.action === 'suspend'
            ? ConnectionStatus.NEEDS_ATTENTION
            : payload.action === 'unsuspend'
              ? ConnectionStatus.CONNECTED
              : undefined;
      if (!status) return null;
      return {
        eventType: `installation.${payload.action}`,
        resourceKey: '',
        accountId: String(installationId),
        data: {},
        connectionStatus: status,
      };
    }

    if (event !== 'issues' || payload.action !== 'opened') return null;
    const { issue, repository, sender } = payload;
    if (!issue || !repository?.full_name) return null;

    return {
      eventType: 'issues.opened',
      // Repository names are case-insensitive on GitHub.
      resourceKey: repository.full_name.toLowerCase(),
      accountId: String(installationId),
      data: {
        issue: {
          number: issue.number,
          title: issue.title,
          body: issue.body ? issue.body.slice(0, MAX_BODY_CHARS) : '',
          url: issue.html_url,
          state: issue.state,
          createdAt: issue.created_at,
          labels: (issue.labels ?? [])
            .map((l) => (typeof l === 'string' ? l : l.name))
            .filter(Boolean),
          author: { login: issue.user?.login, type: issue.user?.type },
        },
        repository: { fullName: repository.full_name, private: repository.private ?? false },
        sender: { login: sender?.login, type: sender?.type },
      },
    };
  }
}
