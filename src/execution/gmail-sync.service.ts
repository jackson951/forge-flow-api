import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import {
  ConnectionStatus,
  ConnectionStatusReason,
  IntegrationProviderKey,
  Prisma,
  ProviderSubscription,
  SubscriptionStatus,
  TriggerSource,
  WorkflowStatus,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';
import { ExecutionError } from '../engine/errors';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { GmailSyncJobData, JOBS, QUEUES } from '../infrastructure/queue/queue.constants';
import { RunQueue } from '../infrastructure/queue/run-queue.service';
import { GmailClient, GmailHistoryGoneError } from '../modules/integrations/gmail/gmail-client';
import {
  bareAddress,
  emailOutput,
  normalizeMessage,
} from '../modules/integrations/gmail/gmail-mime';
import { GmailTokenManager } from '../modules/integrations/gmail/gmail-token-manager';
import { GMAIL_TRIGGERS, GmailTriggerFilter } from '../modules/integrations/gmail/gmail.node-types';
import { MAX_SUBSCRIPTION_FAILURES, SyncResult } from './jira-subscriptions.service';

/** The one Gmail subscription row of a connection (its mailbox watch). */
const RESOURCE = 'mailbox';
/**
 * Bounds of one resolution. A larger backlog is resolved in several passes: the stored history
 * id only advances past what was actually processed, and a follow-up resolution is queued
 * (Part 27: advancing to the mailbox's current id after a truncated pass skipped the rest).
 */
const MAX_HISTORY_PAGES = 20;
const MAX_MESSAGES = 200;

interface WatchDetails {
  labelIds: string[];
  historyId: string;
  emailAddress: string;
  lastNotificationAt?: string;
  gapAt?: string;
}

interface ActiveTrigger {
  workflowId: string;
  workspaceId: string;
  workflowVersionId: string;
  eventType: string;
  filter: GmailTriggerFilter;
}

export interface ResolveResult {
  messages: number;
  runs: number;
  gap: boolean;
  /** More history remains: a follow-up resolution was queued. */
  truncated: boolean;
}

const byHistory = (a: string, b: string) => (BigInt(a) > BigInt(b) ? a : b);

/**
 * Gmail in the worker (Part 26): the mailbox watch lifecycle (FR-26.4 / 26.10) and history
 * resolution (FR-26.6 / 26.7), both serialised per connection with an advisory lock so the
 * stored historyId only ever moves forward and concurrent resolutions cannot repeat a message.
 * Exactly one run per (workflow, message) is guaranteed by the unique run key
 * `gmail:<connectionId>:<messageId>:<workflowId>` (one trigger per workflow).
 */
@Injectable()
export class GmailSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gmail: GmailClient,
    private readonly tokens: GmailTokenManager,
    private readonly runs: RunQueue,
    private readonly config: AppConfigService,
    @InjectQueue(QUEUES.PROVIDER_EVENTS) private readonly events: Queue<GmailSyncJobData>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GmailSyncService.name);
  }

  // ── Watch lifecycle ─────────────────────────────────────────────────────────

  /** Watches follow the published triggers; renew before expiry; stop when unused. */
  async run(workspaceId?: string, now = new Date()): Promise<SyncResult> {
    const result: SyncResult = { registered: 0, unchanged: 0, removed: 0, renewed: 0, failed: 0 };
    if (!this.gmail.triggersConfigured()) return result;
    const connections = await this.prisma.integrationConnection.findMany({
      where: { provider: IntegrationProviderKey.GMAIL, ...(workspaceId && { workspaceId }) },
      select: { id: true },
    });
    for (const { id } of connections) {
      let catchUp = false;
      await this.locked(id, async () => {
        catchUp = await this.syncWatch(id, result, now);
      });
      if (catchUp) await this.requestResolve(id);
    }
    if (Object.values(result).some(Boolean)) this.logger.info(result, 'Gmail watch sync');
    return result;
  }

  private async syncWatch(connectionId: string, result: SyncResult, now: Date): Promise<boolean> {
    const connection = await this.prisma.integrationConnection.findUnique({
      where: { id: connectionId },
      select: { id: true, workspaceId: true, status: true, statusReason: true, accountLabel: true },
    });
    if (!connection) return false;
    if (
      connection.status !== ConnectionStatus.CONNECTED &&
      connection.statusReason !== ConnectionStatusReason.WATCH_RENEWAL_FAILED
    ) {
      return false;
    }
    const triggers = await this.activeTriggers(connectionId);
    const labels = [
      ...new Set(
        triggers.map((t) =>
          t.eventType === GMAIL_TRIGGERS.received ? 'INBOX' : t.filter.labelId!,
        ),
      ),
    ].sort();
    const sub = await this.prisma.providerSubscription.findUnique({
      where: { connectionId_resourceKey: { connectionId, resourceKey: RESOURCE } },
    });
    try {
      if (!labels.length) {
        if (sub) {
          await this.stopIfUnshared(connection, sub);
          result.removed++;
        }
        return false;
      }
      const details = sub?.details as Partial<WatchDetails> | undefined;
      const sameLabels = JSON.stringify(details?.labelIds ?? []) === JSON.stringify(labels);
      const expiresSoon =
        !sub?.expiresAt ||
        sub.expiresAt.getTime() < now.getTime() + this.config.gmail.renewWithinMs;
      if (sub && sameLabels && !expiresSoon && sub.consecutiveFailures === 0) {
        result.unchanged++;
        return false;
      }
      const expired = Boolean(sub?.expiresAt && sub.expiresAt.getTime() < now.getTime());
      const watch = await this.tokens.withToken(connection.workspaceId, connectionId, (token) =>
        this.gmail.watch(token, this.config.gmail.topic!, labels),
      );
      // Keep the stored start point: re-watching must not skip messages since the last resolution.
      const historyId = details?.historyId || watch.historyId;
      const data = {
        externalIds: [],
        details: {
          ...details,
          labelIds: labels,
          historyId,
          emailAddress: connection.accountLabel ?? '',
        } as Prisma.InputJsonObject,
        status: SubscriptionStatus.ACTIVE,
        expiresAt: watch.expiration,
        lastRenewedAt: new Date(),
        consecutiveFailures: 0,
        lastError: null,
      };
      await this.prisma.providerSubscription.upsert({
        where: { connectionId_resourceKey: { connectionId, resourceKey: RESOURCE } },
        create: {
          ...data,
          workspaceId: connection.workspaceId,
          connectionId,
          provider: IntegrationProviderKey.GMAIL,
          resourceKey: RESOURCE,
        },
        update: data,
      });
      await this.prisma.integrationConnection.updateMany({
        where: { id: connectionId, statusReason: ConnectionStatusReason.WATCH_RENEWAL_FAILED },
        data: { status: ConnectionStatus.CONNECTED, statusReason: null },
      });
      if (sub) result.renewed++;
      else result.registered++;
      this.logger.info(
        { connectionId, labels: labels.length, expiresAt: watch.expiration.toISOString() },
        sub ? 'Gmail watch renewed' : 'Gmail watch started',
      );
      // An expired watch missed notifications: resolve from the stored history id (FR-26.10).
      return expired && Boolean(details?.historyId);
    } catch (err) {
      result.failed++;
      await this.failure(connection, sub, err);
      return false;
    }
  }

  /** Gmail keeps one watch per user and topic: only stop it when no other connection uses it. */
  private async stopIfUnshared(
    connection: { id: string; workspaceId: string; accountLabel: string | null },
    sub: ProviderSubscription,
  ) {
    const others = await this.prisma.providerSubscription.count({
      where: {
        provider: IntegrationProviderKey.GMAIL,
        connectionId: { not: connection.id },
        connection: { accountLabel: connection.accountLabel },
      },
    });
    if (!others) {
      await this.tokens
        .withToken(connection.workspaceId, connection.id, (token) => this.gmail.stop(token))
        .catch((err: Error) =>
          this.logger.warn(
            { connectionId: connection.id, error: err.message },
            'Could not stop the Gmail watch; it expires within 7 days',
          ),
        );
    }
    await this.prisma.providerSubscription.delete({ where: { id: sub.id } });
    this.logger.info({ connectionId: connection.id, shared: others > 0 }, 'Gmail watch removed');
  }

  private async failure(
    connection: { id: string; workspaceId: string },
    sub: ProviderSubscription | null,
    err: unknown,
  ) {
    const message = (
      err instanceof ExecutionError || err instanceof Error ? err.message : 'error'
    ).slice(0, 300);
    const failures = (sub?.consecutiveFailures ?? 0) + 1;
    const data = {
      consecutiveFailures: failures,
      lastError: message,
      status:
        failures >= MAX_SUBSCRIPTION_FAILURES
          ? SubscriptionStatus.FAILING
          : SubscriptionStatus.ACTIVE,
    };
    if (sub) await this.prisma.providerSubscription.update({ where: { id: sub.id }, data });
    else {
      await this.prisma.providerSubscription.create({
        data: {
          ...data,
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
          provider: IntegrationProviderKey.GMAIL,
          resourceKey: RESOURCE,
          externalIds: [],
          details: {},
        },
      });
    }
    this.logger.warn(
      { connectionId: connection.id, failures, error: message },
      'Gmail watch failed',
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

  // ── History resolution ──────────────────────────────────────────────────────

  async requestResolve(connectionId: string): Promise<void> {
    await this.events
      .add(JOBS.GMAIL_SYNC, { connectionId }, { removeOnComplete: true, removeOnFail: 100 })
      .catch(() => undefined);
  }

  /** New messages since the stored history id → one run per matching (workflow, message). */
  async resolve(connectionId: string): Promise<ResolveResult> {
    const result: ResolveResult = { messages: 0, runs: 0, gap: false, truncated: false };
    const runIds: string[] = [];
    await this.locked(connectionId, async () => {
      const sub = await this.prisma.providerSubscription.findUnique({
        where: { connectionId_resourceKey: { connectionId, resourceKey: RESOURCE } },
        include: { connection: { select: { workspaceId: true, accountLabel: true } } },
      });
      const details = sub?.details as Partial<WatchDetails> | undefined;
      if (!sub || !details?.historyId) return;
      const workspaceId = sub.connection.workspaceId;
      const mailbox = (sub.connection.accountLabel ?? '').toLowerCase();
      const triggers = await this.activeTriggers(connectionId);
      if (!triggers.length) return;

      const added = new Map<string, string[]>();
      const labelAdds = new Map<string, Set<string>>();
      /** History id of the record where each message first appeared (for a partial pass). */
      const firstSeen = new Map<string, bigint>();
      let latest = details.historyId;
      let lastRecord: string | undefined;
      let current: string | undefined;
      try {
        await this.tokens.withToken(workspaceId, connectionId, async (token) => {
          let pageToken: string | undefined;
          for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
            const res = await this.gmail.history(token, details.historyId!, pageToken);
            for (const h of res.history) {
              const at = h.id !== undefined ? String(h.id) : undefined;
              const seen = (id: string) => {
                if (at && !firstSeen.has(id)) firstSeen.set(id, BigInt(at));
              };
              for (const m of h.messagesAdded ?? [])
                if (m.message?.id) {
                  added.set(m.message.id, m.message.labelIds ?? []);
                  seen(m.message.id);
                }
              for (const l of h.labelsAdded ?? []) {
                if (!l.message?.id) continue;
                const set = labelAdds.get(l.message.id) ?? new Set<string>();
                for (const id of l.labelIds ?? []) set.add(id);
                labelAdds.set(l.message.id, set);
                seen(l.message.id);
              }
              if (at) lastRecord = at;
            }
            if (res.historyId) current = res.historyId;
            if (!res.nextPageToken) {
              // Everything read: the mailbox's current history id is the new start.
              if (res.historyId) latest = byHistory(latest, res.historyId);
              return;
            }
            pageToken = res.nextPageToken;
          }
          // Page cap reached: continue after the last record read, not from the current id.
          result.truncated = true;
          // (Without record ids there is no safe resume point: fall back to the current id.)
          latest = byHistory(latest, lastRecord ?? current ?? latest);
        });
      } catch (err) {
        if (!(err instanceof GmailHistoryGoneError)) throw err;
        await this.gap(sub, details, workspaceId, connectionId);
        result.gap = true;
        return;
      }

      // Which triggers each message matches (by labels; filters need the message itself).
      const matches = new Map<string, ActiveTrigger[]>();
      for (const id of new Set([...added.keys(), ...labelAdds.keys()])) {
        const labels = new Set([...(added.get(id) ?? []), ...(labelAdds.get(id) ?? [])]);
        const hit = triggers.filter((t) =>
          labels.has(t.eventType === GMAIL_TRIGGERS.received ? 'INBOX' : t.filter.labelId!),
        );
        if (hit.length) matches.set(id, hit);
      }
      // Oldest first; past MAX_MESSAGES, stop just before the record of the first message left
      // out (messages of that record already handled are deduplicated by their run key).
      const ordered = [...matches.entries()].sort(([a], [b]) =>
        Number((firstSeen.get(a) ?? 0n) - (firstSeen.get(b) ?? 0n)),
      );
      const cutoff = ordered.length > MAX_MESSAGES ? firstSeen.get(ordered[MAX_MESSAGES][0]) : null;
      if (cutoff !== null && cutoff !== undefined) {
        result.truncated = true;
        // Always progress: if the cut falls in the first record, resume after that record.
        const start = BigInt(details.historyId);
        latest = String(cutoff - 1n > start ? cutoff - 1n : cutoff);
      }

      const rows: Prisma.WorkflowRunCreateManyInput[] = [];
      await this.tokens.withToken(workspaceId, connectionId, async (token) => {
        for (const [messageId, hit] of ordered.slice(0, MAX_MESSAGES)) {
          let message;
          try {
            message = await this.gmail.message(token, messageId);
          } catch (err) {
            if (err instanceof ExecutionError && err.message.startsWith('Gmail: not found'))
              continue; // deleted meanwhile
            throw err;
          }
          result.messages++;
          const email = emailOutput(
            normalizeMessage(message, mailbox, this.config.gmail.maxBodyChars),
          );
          for (const trigger of hit.filter((t) => passes(t.filter, email, mailbox))) {
            rows.push({
              id: randomUUID(),
              workspaceId: trigger.workspaceId,
              workflowId: trigger.workflowId,
              workflowVersionId: trigger.workflowVersionId,
              triggerSource: TriggerSource.WEBHOOK,
              idempotencyKey: `gmail:${connectionId}:${messageId}:${trigger.workflowId}`,
              triggerInput: {
                event: trigger.eventType,
                ...email,
              } as unknown as Prisma.InputJsonObject,
              correlationId: randomUUID(),
            });
          }
        }
      });
      if (rows.length) {
        // ON CONFLICT DO NOTHING: duplicate notifications / resolutions create nothing new.
        await this.prisma.workflowRun.createMany({ data: rows, skipDuplicates: true });
        const created = await this.prisma.workflowRun.findMany({
          where: { id: { in: rows.map((r) => r.id!) } },
          select: { id: true },
        });
        runIds.push(...created.map((r) => r.id));
      }
      result.runs = runIds.length;
      await this.prisma.providerSubscription.update({
        where: { id: sub.id },
        data: {
          details: {
            ...details,
            historyId: byHistory(details.historyId, latest),
            lastNotificationAt: new Date().toISOString(),
          } as Prisma.InputJsonObject,
        },
      });
    });
    for (const runId of runIds) {
      await this.runs
        .enqueue(runId, { reason: 'gmail', connectionId })
        .catch((err: Error) =>
          this.logger.warn(
            { runId, error: err.message },
            'Enqueue failed; the sweeper will pick the run up',
          ),
        );
    }
    if (result.truncated) await this.requestResolve(connectionId);
    this.logger.info({ connectionId, ...result }, 'Gmail history resolved');
    return result;
  }

  /**
   * FR-26.7: the stored history id is too old (e.g. after a long outage). Record the gap, restart
   * from the mailbox's current history id, and do not backfill.
   */
  private async gap(
    sub: ProviderSubscription,
    details: Partial<WatchDetails>,
    workspaceId: string,
    connectionId: string,
  ) {
    const profile = await this.tokens.withToken(workspaceId, connectionId, (token) =>
      this.gmail.profile(token),
    );
    await this.prisma.providerSubscription.update({
      where: { id: sub.id },
      data: {
        details: {
          ...details,
          historyId: String(profile.historyId ?? details.historyId),
          gapAt: new Date().toISOString(),
        } as Prisma.InputJsonObject,
        lastError: 'Gmail history gap: changes before the restart point were not processed',
      },
    });
    this.logger.warn(
      { connectionId, gap: true },
      'Gmail history gap: restarted from the current history id (no backfill)',
    );
  }

  private async activeTriggers(connectionId: string): Promise<ActiveTrigger[]> {
    const rows = await this.prisma.workflowTrigger.findMany({
      where: {
        provider: IntegrationProviderKey.GMAIL,
        connectionId,
        workflow: { status: WorkflowStatus.PUBLISHED },
      },
      select: {
        workflowId: true,
        workspaceId: true,
        workflowVersionId: true,
        eventType: true,
        filter: true,
        workflow: { select: { activeVersionId: true } },
      },
    });
    return rows
      .filter((r) => r.workflowVersionId === r.workflow.activeVersionId)
      .map((r) => ({ ...r, filter: (r.filter ?? {}) as GmailTriggerFilter }));
  }

  private locked(connectionId: string, work: () => Promise<void>): Promise<void> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${`gmail:${connectionId}`}))) AS l`;
        await work();
      },
      { maxWait: 10_000, timeout: 180_000 },
    );
  }
}

/** Trigger filters: self-sent exclusion, from, subject (case-insensitive contains). */
export function passes(
  filter: GmailTriggerFilter,
  email: { labelIds: string[]; from: string | null; subject: string | null },
  mailbox: string,
): boolean {
  const sentByMe =
    email.labelIds.includes('SENT') || (email.from ? bareAddress(email.from) === mailbox : false);
  if (sentByMe && !filter.includeSentByMe) return false;
  if (filter.from && !(email.from ?? '').toLowerCase().includes(filter.from.toLowerCase()))
    return false;
  if (
    filter.subjectContains &&
    !(email.subject ?? '').toLowerCase().includes(filter.subjectContains.toLowerCase())
  )
    return false;
  return true;
}
