import { Injectable } from '@nestjs/common';
import { IntegrationProviderKey } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AppConfigService } from '../../../config/app-config.service';
import {
  header,
  InboundWebhook,
  NormalizedEvent,
  VerificationResult,
  WebhookProvider,
} from '../../webhooks/providers/webhook-provider';
import { MAX_TEXT, normalizeIssue } from './jira-client';
import { verifyBearerJwt, verifyWebhookParams } from './jira-webhook-auth';

export const JIRA_TRIGGER_EVENTS = {
  created: 'jira.issue.created',
  updated: 'jira.issue.updated',
  transitioned: 'jira.issue.transitioned',
} as const;

/** Per-trigger filter stored on WorkflowTrigger.filter (from the trigger's config). */
export interface JiraTriggerFilter {
  projectKeys: string[];
  issueTypes?: string[];
  fromStatus?: string;
  toStatus?: string;
}

interface JiraChangeItem {
  field?: string;
  fromString?: string | null;
  toString?: string | null;
}

interface JiraWebhookPayload {
  webhookEvent?: string;
  timestamp?: number;
  issue?: { id?: string; key?: string; self?: string; fields?: Record<string, unknown> };
  user?: { accountId?: string; displayName?: string };
  changelog?: { id?: string; items?: JiraChangeItem[] };
}

const MAX_CHANGES = 50;

/** Site URL from an issue's `self` link when it is the site host (OAuth payloads may use api.atlassian.com). */
function siteUrlFrom(self: string | undefined): string | undefined {
  try {
    const url = new URL(self ?? '');
    return /\.atlassian\.net$/i.test(url.hostname) ? `${url.protocol}//${url.host}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Jira Cloud dynamic webhooks (Part 25, FR-25.5): `POST /webhooks/jira?c=&s=&sig=`.
 *
 * - Authenticity: Atlassian's bearer JWT signed with the app's client secret, and our signed
 *   URL parameters (connection + site) — both required.
 * - Dedup: `X-Atlassian-Webhook-Identifier` (stable across Atlassian retries) plus a hash of
 *   event, issue, changelog and timestamp.
 * - Routing: the connection that registered the webhook only (`connectionId`), the site as
 *   resourceKey, and the trigger's project / issue type / status filter.
 */
@Injectable()
export class JiraWebhookProvider implements WebhookProvider {
  readonly slug = 'jira';
  readonly key = IntegrationProviderKey.JIRA;

  constructor(private readonly config: AppConfigService) {}

  isEnabled(): boolean {
    return Boolean(this.config.jira.clientId && this.config.jira.clientSecret);
  }

  verify(request: InboundWebhook): VerificationResult {
    const secret = this.config.jira.clientSecret!;
    if (!verifyWebhookParams(secret, request.query ?? {})) {
      return { ok: false, reason: 'webhook URL signature mismatch' };
    }
    return verifyBearerJwt(secret, header(request, 'authorization'));
  }

  deliveryId(request: InboundWebhook): string | undefined {
    const body = (request.body ?? {}) as JiraWebhookPayload;
    const identifier = header(request, 'x-atlassian-webhook-identifier') ?? 'none';
    const fingerprint = createHash('sha256')
      .update(
        [
          body.webhookEvent,
          body.issue?.id,
          body.changelog?.id,
          body.timestamp,
          (request.query ?? {}).c,
        ].join('|'),
      )
      .digest('hex')
      .slice(0, 32);
    return `${identifier.slice(0, 100)}:${fingerprint}`;
  }

  eventName(request: InboundWebhook): string {
    const event = ((request.body ?? {}) as JiraWebhookPayload).webhookEvent;
    return typeof event === 'string' ? event.slice(0, 100) : 'unknown';
  }

  normalize(request: InboundWebhook): NormalizedEvent | null {
    const target = verifyWebhookParams(this.config.jira.clientSecret!, request.query ?? {});
    const body = (request.body ?? {}) as JiraWebhookPayload;
    if (!target || !body.issue?.key) return null;

    const changes = (body.changelog?.items ?? []).slice(0, MAX_CHANGES).map((item) => ({
      field: typeof item.field === 'string' ? item.field : null,
      from: typeof item.fromString === 'string' ? item.fromString.slice(0, 500) : null,
      to: typeof item.toString === 'string' ? item.toString.slice(0, 500) : null,
    }));
    const statusChange = changes.find((c) => c.field === 'status');

    let eventTypes: string[];
    if (body.webhookEvent === 'jira:issue_created') eventTypes = [JIRA_TRIGGER_EVENTS.created];
    else if (body.webhookEvent === 'jira:issue_updated') {
      eventTypes = statusChange
        ? [JIRA_TRIGGER_EVENTS.updated, JIRA_TRIGGER_EVENTS.transitioned]
        : [JIRA_TRIGGER_EVENTS.updated];
    } else return null;

    const issue = normalizeIssue(body.issue, siteUrlFrom(body.issue.self));
    return {
      eventType: eventTypes[0],
      eventTypes,
      resourceKey: target.cloudId,
      connectionId: target.connectionId,
      data: {
        event: eventTypes[eventTypes.length - 1],
        issue: { ...issue, description: issue.description?.slice(0, MAX_TEXT) ?? null },
        changes,
        ...(statusChange && { transition: { from: statusChange.from, to: statusChange.to } }),
        actor: body.user?.accountId
          ? { accountId: body.user.accountId, displayName: body.user.displayName ?? null }
          : null,
        site: { cloudId: target.cloudId },
      },
    };
  }

  /** The trigger's filter: projects, optional issue types, and (transitioned) from/to status. */
  matches(event: NormalizedEvent, filter: unknown, eventType: string): boolean {
    const f = (filter ?? {}) as Partial<JiraTriggerFilter>;
    const issue = event.data.issue as { project: { key: string | null }; type: string | null };
    if (!f.projectKeys?.includes(issue.project.key ?? '')) return false;
    if (
      f.issueTypes?.length &&
      !f.issueTypes.some((t) => t.toLowerCase() === (issue.type ?? '').toLowerCase())
    ) {
      return false;
    }
    if (eventType === JIRA_TRIGGER_EVENTS.transitioned) {
      const transition = event.data.transition as
        { from: string | null; to: string | null } | undefined;
      if (!transition) return false;
      const same = (a: string | undefined, b: string | null) =>
        !a || a.toLowerCase() === (b ?? '').toLowerCase();
      if (!same(f.fromStatus, transition.from) || !same(f.toStatus, transition.to)) return false;
    }
    return true;
  }
}
