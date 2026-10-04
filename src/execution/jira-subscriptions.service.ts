import { Injectable } from '@nestjs/common';
import {
  ConnectionStatus,
  ConnectionStatusReason,
  IntegrationProviderKey,
  Prisma,
  ProviderSubscription,
  SubscriptionStatus,
  WorkflowStatus,
} from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { ExecutionError } from '../engine/errors';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { JiraClient } from '../modules/integrations/jira/jira-client';
import { JiraTokenManager } from '../modules/integrations/jira/jira-token-manager';
import { webhookUrl } from '../modules/integrations/jira/jira-webhook-auth';
import { JiraTriggerFilter } from '../modules/integrations/jira/jira-webhook.provider';

/** Consecutive failures after which the connection needs attention (FR-25.8). */
export const MAX_SUBSCRIPTION_FAILURES = 3;
const LIFETIME_MS = 30 * 86_400_000;

export interface SyncResult {
  registered: number;
  unchanged: number;
  removed: number;
  renewed: number;
  failed: number;
}

interface JiraDetails {
  jql: string;
  projectKeys: string[];
}

/** One JQL per (connection, site): the union of the published triggers' projects. */
export const projectsJql = (keys: string[]) =>
  `project IN (${[...new Set(keys)]
    .sort()
    .map((k) => `"${k}"`)
    .join(', ')})`;

/**
 * Jira dynamic webhooks (Part 25, FR-25.4 / 25.8), in the worker. A connection gets one webhook
 * per site, covering every project its published Jira triggers listen to (Atlassian allows only
 * 5 webhooks per app, user and site); issue type and status filters are applied by FlowForge.
 *
 * - sync: desired (published triggers) vs registered; registers, re-registers on change,
 *   deletes when nothing needs it;
 * - renew: webhooks expiring within JIRA_WEBHOOK_RENEW_WITHIN_DAYS are extended by 30 days;
 * - failures are counted per registration; from the 3rd the connection is NEEDS_ATTENTION
 *   (WATCH_RENEWAL_FAILED); a later success clears it.
 */
@Injectable()
export class JiraSubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jira: JiraClient,
    private readonly tokens: JiraTokenManager,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(JiraSubscriptionsService.name);
  }

  /** Sync every Jira connection (of one workspace), then renew what expires soon. */
  async run(workspaceId?: string, now = new Date()): Promise<SyncResult> {
    const result: SyncResult = { registered: 0, unchanged: 0, removed: 0, renewed: 0, failed: 0 };
    if (!this.jira.isConfigured()) return result;
    const connections = await this.prisma.integrationConnection.findMany({
      where: { provider: IntegrationProviderKey.JIRA, ...(workspaceId && { workspaceId }) },
      select: { id: true },
    });
    for (const { id } of connections) {
      // One sync/renewal per connection at a time (across workers and the on-demand job):
      // two concurrent registrations would leave an orphaned webhook at Jira.
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${`jira-subscriptions:${id}`}))) AS l`;
          const connection = await this.prisma.integrationConnection.findUnique({
            where: { id },
            select: { id: true, workspaceId: true, status: true, statusReason: true },
          });
          if (!connection) return;
          await this.syncConnection(connection, result);
          await this.renewExpiring(result, connection.id, now);
        },
        { maxWait: 10_000, timeout: 180_000 },
      );
    }
    if (Object.values(result).some(Boolean)) this.logger.info(result, 'Jira webhook sync');
    return result;
  }

  private async syncConnection(
    connection: {
      id: string;
      workspaceId: string;
      status: ConnectionStatus;
      statusReason: ConnectionStatusReason | null;
    },
    result: SyncResult,
  ): Promise<void> {
    // A connection that needs a reconnect cannot call Jira (renewal failures still may retry).
    if (
      connection.status !== ConnectionStatus.CONNECTED &&
      connection.statusReason !== ConnectionStatusReason.WATCH_RENEWAL_FAILED
    ) {
      return;
    }
    const triggers = await this.prisma.workflowTrigger.findMany({
      where: {
        provider: IntegrationProviderKey.JIRA,
        connectionId: connection.id,
        workflow: { status: WorkflowStatus.PUBLISHED },
      },
      select: {
        resourceKey: true,
        filter: true,
        workflowVersionId: true,
        workflow: { select: { activeVersionId: true } },
      },
    });
    const desired = new Map<string, string[]>();
    for (const t of triggers) {
      if (t.workflowVersionId !== t.workflow.activeVersionId) continue;
      const keys = (t.filter as Partial<JiraTriggerFilter> | null)?.projectKeys ?? [];
      desired.set(t.resourceKey, [...(desired.get(t.resourceKey) ?? []), ...keys]);
    }
    const existing = await this.prisma.providerSubscription.findMany({
      where: { connectionId: connection.id, provider: IntegrationProviderKey.JIRA },
    });
    const sites = new Set([...desired.keys(), ...existing.map((s) => s.resourceKey)]);
    for (const cloudId of sites) {
      const current = existing.find((s) => s.resourceKey === cloudId);
      const keys = desired.get(cloudId) ?? [];
      try {
        if (!keys.length) {
          if (current) await this.remove(connection, current);
          result.removed += current ? 1 : 0;
          continue;
        }
        const jql = projectsJql(keys);
        if (
          current &&
          (current.details as Partial<JiraDetails>).jql === jql &&
          current.externalIds.length
        ) {
          result.unchanged++;
          continue;
        }
        await this.register(connection, cloudId, jql, [...new Set(keys)].sort(), current);
        result.registered++;
      } catch (err) {
        result.failed++;
        await this.failure(connection, cloudId, current, err);
      }
    }
  }

  private async register(
    connection: { id: string; workspaceId: string },
    cloudId: string,
    jql: string,
    projectKeys: string[],
    current: ProviderSubscription | undefined,
  ): Promise<void> {
    const url = webhookUrl(
      this.webhookBase(),
      this.config.jira.clientSecret!,
      connection.id,
      cloudId,
    );
    await this.tokens.site(connection.workspaceId, connection.id, cloudId);
    const ids = await this.tokens.withToken(
      connection.workspaceId,
      connection.id,
      async (token) => {
        // Replace, never accumulate: the old registration is removed first (best effort).
        if (current?.externalIds.length) {
          await this.jira
            .deleteWebhooks(token, cloudId, current.externalIds)
            .catch(() => undefined);
        }
        return this.jira.registerWebhook(token, cloudId, url, jql);
      },
    );
    const now = new Date();
    const data = {
      externalIds: ids,
      details: { jql, projectKeys } as Prisma.InputJsonObject,
      status: SubscriptionStatus.ACTIVE,
      expiresAt: new Date(now.getTime() + LIFETIME_MS),
      lastRenewedAt: now,
      consecutiveFailures: 0,
      lastError: null,
    };
    await this.prisma.providerSubscription.upsert({
      where: { connectionId_resourceKey: { connectionId: connection.id, resourceKey: cloudId } },
      create: {
        ...data,
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        provider: IntegrationProviderKey.JIRA,
        resourceKey: cloudId,
      },
      update: data,
    });
    await this.clearRenewalFailure(connection);
    this.logger.info(
      { connectionId: connection.id, cloudId, webhookIds: ids, projects: projectKeys.length },
      'Jira webhook registered',
    );
  }

  private async remove(
    connection: { id: string; workspaceId: string },
    current: ProviderSubscription,
  ): Promise<void> {
    if (current.externalIds.length) {
      await this.tokens
        .withToken(connection.workspaceId, connection.id, (token) =>
          this.jira.deleteWebhooks(token, current.resourceKey, current.externalIds),
        )
        .catch((err: Error) =>
          this.logger.warn(
            { connectionId: connection.id, error: err.message },
            'Could not delete a Jira webhook; it expires on its own',
          ),
        );
    }
    await this.prisma.providerSubscription.delete({ where: { id: current.id } });
    this.logger.info(
      { connectionId: connection.id, cloudId: current.resourceKey },
      'Jira webhook removed',
    );
  }

  /** Extends registrations that expire within the renewal window (FR-25.8). */
  private async renewExpiring(result: SyncResult, connectionId: string, now: Date): Promise<void> {
    const due = await this.prisma.providerSubscription.findMany({
      where: {
        provider: IntegrationProviderKey.JIRA,
        connectionId,
        externalIds: { isEmpty: false },
        expiresAt: { lt: new Date(now.getTime() + this.config.jira.renewWithinMs) },
      },
      include: { connection: { select: { id: true, workspaceId: true } } },
    });
    for (const sub of due) {
      try {
        const expiresAt = await this.tokens.withToken(sub.workspaceId, sub.connectionId, (token) =>
          this.jira.refreshWebhooks(token, sub.resourceKey, sub.externalIds),
        );
        await this.prisma.providerSubscription.update({
          where: { id: sub.id },
          data: {
            expiresAt,
            lastRenewedAt: new Date(),
            consecutiveFailures: 0,
            status: SubscriptionStatus.ACTIVE,
            lastError: null,
          },
        });
        await this.clearRenewalFailure(sub.connection);
        result.renewed++;
      } catch (err) {
        result.failed++;
        await this.failure(sub.connection, sub.resourceKey, sub, err);
      }
    }
  }

  private async failure(
    connection: { id: string; workspaceId: string },
    cloudId: string,
    current: ProviderSubscription | undefined,
    err: unknown,
  ): Promise<void> {
    const message = (
      err instanceof ExecutionError || err instanceof Error ? err.message : 'error'
    ).slice(0, 300);
    const failures = (current?.consecutiveFailures ?? 0) + 1;
    if (current) {
      await this.prisma.providerSubscription.update({
        where: { id: current.id },
        data: {
          consecutiveFailures: failures,
          lastError: message,
          status:
            failures >= MAX_SUBSCRIPTION_FAILURES
              ? SubscriptionStatus.FAILING
              : SubscriptionStatus.ACTIVE,
        },
      });
    } else {
      // Remember the failed first registration, so the failure count builds up.
      await this.prisma.providerSubscription.create({
        data: {
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
          provider: IntegrationProviderKey.JIRA,
          resourceKey: cloudId,
          externalIds: [],
          details: { jql: '', projectKeys: [] },
          consecutiveFailures: 1,
          lastError: message,
        },
      });
    }
    this.logger.warn(
      { connectionId: connection.id, cloudId, failures, error: message },
      'Jira webhook sync/renewal failed',
    );
    if (failures >= MAX_SUBSCRIPTION_FAILURES) {
      await this.prisma.integrationConnection.updateMany({
        where: { id: connection.id, status: ConnectionStatus.CONNECTED },
        data: {
          status: ConnectionStatus.NEEDS_ATTENTION,
          statusReason: ConnectionStatusReason.WATCH_RENEWAL_FAILED,
        },
      });
    }
  }

  /** A renewal-only failure heals itself: the connection is usable again. */
  private async clearRenewalFailure(connection: { id: string }): Promise<void> {
    await this.prisma.integrationConnection.updateMany({
      where: { id: connection.id, statusReason: ConnectionStatusReason.WATCH_RENEWAL_FAILED },
      data: { status: ConnectionStatus.CONNECTED, statusReason: null },
    });
  }

  /** Base of the public API (Atlassian requires the app's base URL), e.g. https://host/api/v1. */
  private webhookBase(): string {
    const prefix = this.config.get('API_PREFIX');
    const publicUrl = this.config.hooks.publicApiUrl;
    if (publicUrl) return `${publicUrl.replace(/\/+$/, '')}/${prefix}/v1`;
    const redirect = this.config.get('OAUTH_REDIRECT_BASE_URL');
    if (!redirect)
      throw new Error('Set PUBLIC_API_URL or OAUTH_REDIRECT_BASE_URL to register Jira webhooks');
    return redirect.replace(/\/+$/, '').replace(/\/integrations$/, '');
  }
}
