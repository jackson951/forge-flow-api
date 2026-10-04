import { Inject, Injectable } from '@nestjs/common';
import {
  IntegrationProviderKey,
  Prisma,
  TriggerSource,
  WebhookDeliveryStatus,
  WorkflowStatus,
  WorkflowWebhook,
} from '@prisma/client';
import Redis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service';
import { evaluateCondition } from '../../engine/expressions/conditions';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { QueueBackpressure } from '../../infrastructure/queue/queue-backpressure.service';
import { RunQueue } from '../../infrastructure/queue/run-queue.service';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.module';
import {
  HookTriggerOutput,
  InboundHookRequest,
  MalformedPayloadError,
  parseHookBody,
  pickHeaders,
  pickQuery,
  sourceDeliveryId,
  verifyHookRequest,
  webhookTriggerConfigSchema,
  WebhookTriggerConfig,
} from './hook-config';
import { hashHookId, HookProvisioner } from './hook-provisioner.service';

/** What the controller sends back. Bodies are generic: no oracle for ids or failed checks. */
export interface HookReply {
  status: number;
  body?: unknown;
  /** Plain-text reply (challenge echo). */
  text?: string;
  retryAfterSeconds?: number;
}

const NOT_FOUND: HookReply = { status: 404, body: { statusCode: 404, message: 'Not found' } };
const UNAUTHORIZED: HookReply = { status: 401, body: { statusCode: 401, message: 'Unauthorized' } };
const TX_OPTIONS = { maxWait: 5_000, timeout: 8_000 };
const CAPTURE_TTL_SECONDS = 600;

export const captureKeys = (workflowId: string) => ({
  listening: `ff:hook-capture:listen:${workflowId}`,
  data: `ff:hook-capture:data:${workflowId}`,
});

/**
 * Generic inbound webhooks (Part 24, FR-24.7–24.14) on the Part 09 pipeline:
 *
 *   hook id → active published workflow → method → challenge echo → rate limits → verify
 *   → parse → daily cap → [tx: delivery (unique id) → filter → run] → enqueue → fast reply
 *
 * Nothing runs synchronously; a run is a QUEUED row the worker executes. Duplicates (same
 * sender delivery id) create nothing and get the original reply. Invalid requests leave a
 * REJECTED row without payload; unknown hooks leave nothing.
 */
@Injectable()
export class HookIntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provisioner: HookProvisioner,
    private readonly queue: RunQueue,
    private readonly backpressure: QueueBackpressure,
    private readonly config: AppConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(HookIntakeService.name);
  }

  async receive(
    hookId: string,
    req: InboundHookRequest,
    correlationId?: string,
  ): Promise<HookReply> {
    const started = Date.now();
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(hookId)) return NOT_FOUND;
    const hash = hashHookId(hookId);
    const hook = await this.prisma.workflowWebhook.findFirst({
      where: {
        OR: [
          { hookIdHash: hash },
          { previousHookIdHash: hash, previousHookIdExpiresAt: { gt: new Date() } },
        ],
      },
      include: { workflow: { select: { status: true, activeVersionId: true } } },
    });
    if (!hook) return NOT_FOUND;

    const live =
      hook.active &&
      hook.workflow.status === WorkflowStatus.PUBLISHED &&
      hook.workflowVersionId !== null &&
      hook.workflow.activeVersionId === hook.workflowVersionId;
    if (!live) return this.capture(hook, req);

    const parsedConfig = webhookTriggerConfigSchema.safeParse(hook.config);
    if (!parsedConfig.success) {
      this.logger.warn({ webhookId: hook.id }, 'Stored webhook config is invalid; refusing');
      return NOT_FOUND;
    }
    const config = parsedConfig.data;
    const ids = { webhookId: hook.id, workflowId: hook.workflowId, workspaceId: hook.workspaceId };

    if (!(config.methods as string[]).includes(req.method)) {
      return { status: 405, body: { statusCode: 405, message: 'Method not allowed' } };
    }
    // Endpoint validation by the sender (GET ?challenge=x → x): echoes only that value.
    const challenge = config.challenge && req.query[config.challenge.queryParam];
    if (req.method === 'GET' && typeof challenge === 'string' && challenge.length <= 1_024) {
      return { status: 200, text: challenge };
    }

    const limited = await this.rateLimited(hook.id, config, req.sourceIp);
    if (limited) {
      this.logger.warn({ ...ids, reason: limited }, 'Webhook delivery rate limited');
      return {
        status: 429,
        body: { statusCode: 429, message: 'Too many requests' },
        retryAfterSeconds: 60,
      };
    }

    const verified = verifyHookRequest(config, req, this.secrets(hook));
    if (!verified.ok) {
      await this.reject(hook, req, verified.reason);
      return UNAUTHORIZED;
    }

    let parsed;
    try {
      parsed = parseHookBody(req.rawBody, header(req, 'content-type'));
    } catch (err) {
      if (err instanceof MalformedPayloadError) {
        await this.reject(hook, req, 'malformed JSON body');
        return { status: 400, body: { statusCode: 400, message: 'Malformed JSON body' } };
      }
      throw err;
    }

    if (await this.overDailyCap(hook.workspaceId)) {
      this.logger.warn(ids, 'Workspace daily webhook cap reached');
      return {
        status: 429,
        body: { statusCode: 429, message: 'Daily delivery limit reached' },
        retryAfterSeconds: 3_600,
      };
    }

    const sourceId = sourceDeliveryId(config, req.headers, parsed.body);
    const deliveryId = sourceId ?? randomUUID();
    const dbDeliveryId = `${hook.id}:${sourceId ? `src:${sourceId}` : `gen:${deliveryId}`}`;
    const output: HookTriggerOutput = {
      method: req.method,
      headers: pickHeaders(req.headers, config),
      query: pickQuery(req.query),
      body: parsed.body,
      ...(parsed.rawText !== undefined && { rawText: parsed.rawText }),
      contentType: parsed.contentType,
      receivedAt: new Date().toISOString(),
      deliveryId,
      sourceIp: req.sourceIp,
    };

    let result: { runId: string | null; duplicate: boolean; ignored?: string };
    try {
      result = await this.prisma.$transaction(
        (tx) => this.record(tx, hook, config, dbDeliveryId, output, req, correlationId),
        TX_OPTIONS,
      );
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      result = await this.duplicate(dbDeliveryId);
    }

    if (result.runId && !result.duplicate) {
      await this.backpressure.observe();
      await this.queue
        .enqueue(result.runId, { correlationId, provider: 'webhook', ...ids })
        .catch((err: Error) =>
          this.logger.warn(
            { runId: result.runId, error: err.message },
            'Enqueue failed; the sweeper will pick the run up',
          ),
        );
    }
    this.logger.info(
      {
        ...ids,
        deliveryId,
        duplicate: result.duplicate,
        ignored: result.ignored,
        runId: result.runId,
        sizeBytes: req.rawBody.length,
        durationMs: Date.now() - started,
      },
      result.duplicate ? 'Duplicate webhook delivery' : 'Webhook delivery accepted',
    );

    const status = config.response.status;
    if (status === 204) return { status };
    return {
      status,
      body: config.response.body ?? {
        accepted: true,
        deliveryId,
        ...(result.duplicate && { duplicate: true }),
        ...(result.runId && { runId: result.runId }),
      },
    };
  }

  private async record(
    tx: Prisma.TransactionClient,
    hook: WorkflowWebhook,
    config: WebhookTriggerConfig,
    dbDeliveryId: string,
    output: HookTriggerOutput,
    req: InboundHookRequest,
    correlationId: string | undefined,
  ): Promise<{ runId: string | null; duplicate: false; ignored?: string }> {
    // P2002 on a delivery id seen before: the transaction is discarded (no run).
    const delivery = await tx.webhookDelivery.create({
      data: {
        provider: IntegrationProviderKey.WEBHOOK,
        deliveryId: dbDeliveryId,
        eventType: 'webhook.received',
        workspaceId: hook.workspaceId,
        workflowId: hook.workflowId,
        payload: output as unknown as Prisma.InputJsonObject,
        sizeBytes: req.rawBody.length,
        sourceIp: req.sourceIp,
      },
      select: { id: true },
    });

    const ignored = this.filterReason(config, output);
    if (ignored) {
      await tx.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: WebhookDeliveryStatus.IGNORED, reason: ignored, processedAt: new Date() },
      });
      return { runId: null, duplicate: false, ignored };
    }

    const run = await tx.workflowRun.create({
      data: {
        workspaceId: hook.workspaceId,
        workflowId: hook.workflowId,
        workflowVersionId: hook.workflowVersionId!,
        triggerSource: TriggerSource.WEBHOOK,
        idempotencyKey: `WEBHOOK:${dbDeliveryId}:${hook.workflowId}`,
        webhookDeliveryId: delivery.id,
        triggerInput: output as unknown as Prisma.InputJsonObject,
        correlationId,
      },
      select: { id: true },
    });
    await tx.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: WebhookDeliveryStatus.PROCESSED, processedAt: new Date() },
    });
    return { runId: run.id, duplicate: false };
  }

  /** FR-24.12: a non-matching delivery is stored as IGNORED with the reason. */
  private filterReason(
    config: WebhookTriggerConfig,
    output: HookTriggerOutput,
  ): string | undefined {
    if (!config.filter) return undefined;
    try {
      return evaluateCondition(config.filter, { trigger: output, outputs: {} })
        ? undefined
        : 'filter did not match';
    } catch {
      return 'filter could not be evaluated';
    }
  }

  /** Same sender delivery id again: counted on the original, nothing new is created. */
  private async duplicate(dbDeliveryId: string) {
    const original = await this.prisma.webhookDelivery.update({
      where: {
        provider_deliveryId: { provider: IntegrationProviderKey.WEBHOOK, deliveryId: dbDeliveryId },
      },
      data: { duplicateCount: { increment: 1 }, lastDuplicateAt: new Date() },
      select: { runs: { select: { id: true }, orderBy: { createdAt: 'asc' }, take: 1 } },
    });
    return { runId: original.runs[0]?.id ?? null, duplicate: true };
  }

  /** Verification failed: a REJECTED row with the reason only (no payload, no headers). */
  private async reject(hook: WorkflowWebhook, req: InboundHookRequest, reason: string) {
    this.logger.warn(
      { webhookId: hook.id, workflowId: hook.workflowId, reason, sourceIp: req.sourceIp },
      'Webhook delivery rejected',
    );
    await this.prisma.webhookDelivery.create({
      data: {
        provider: IntegrationProviderKey.WEBHOOK,
        deliveryId: `${hook.id}:rejected:${randomUUID()}`,
        eventType: 'webhook.received',
        workspaceId: hook.workspaceId,
        workflowId: hook.workflowId,
        status: WebhookDeliveryStatus.REJECTED,
        reason,
        sizeBytes: req.rawBody.length,
        sourceIp: req.sourceIp,
        processedAt: new Date(),
      },
    });
  }

  /** Current secret, plus the previous one during its rotation grace period (FR-24.9). */
  private secrets(hook: WorkflowWebhook): string[] {
    const secrets: string[] = [];
    if (hook.encryptedSecret)
      secrets.push(this.provisioner.open(hook.id, 'secret', hook.encryptedSecret));
    if (
      hook.previousEncryptedSecret &&
      hook.previousSecretExpiresAt &&
      hook.previousSecretExpiresAt.getTime() > Date.now()
    ) {
      secrets.push(this.provisioner.open(hook.id, 'previousSecret', hook.previousEncryptedSecret));
    }
    return secrets;
  }

  /**
   * Not live (draft, archived, other trigger): only a pending "listen for a test event"
   * request takes the delivery (FR-24.15), once; otherwise the hook does not exist.
   */
  private async capture(hook: WorkflowWebhook, req: InboundHookRequest): Promise<HookReply> {
    const keys = captureKeys(hook.workflowId);
    let listening: number;
    try {
      listening = await this.redis.del(keys.listening);
    } catch {
      return NOT_FOUND;
    }
    if (!listening) return NOT_FOUND;
    let parsed;
    try {
      parsed = parseHookBody(req.rawBody, header(req, 'content-type'));
    } catch {
      parsed = {
        body: null,
        rawText: req.rawBody.toString('utf8'),
        contentType: header(req, 'content-type') ?? '',
      };
    }
    const sample = {
      method: req.method,
      headers: pickHeaders(req.headers, webhookTriggerConfigSchema.parse({})),
      query: pickQuery(req.query),
      body: parsed.body,
      ...(parsed.rawText !== undefined && { rawText: parsed.rawText }),
      contentType: parsed.contentType,
      receivedAt: new Date().toISOString(),
      deliveryId: randomUUID(),
      sourceIp: req.sourceIp,
    };
    await this.redis.set(keys.data, JSON.stringify(sample), 'EX', CAPTURE_TTL_SECONDS);
    this.logger.info(
      { webhookId: hook.id, workflowId: hook.workflowId },
      'Test webhook event captured',
    );
    return { status: 202, body: { accepted: true, captured: true } };
  }

  /** Per-hook and per-source-IP counters in Redis (fixed one-minute windows). Fails open. */
  private async rateLimited(
    webhookId: string,
    config: WebhookTriggerConfig,
    ip: string,
  ): Promise<string | null> {
    const minute = Math.floor(Date.now() / 60_000);
    const hookKey = `ff:hook-rl:${webhookId}:${minute}`;
    const ipKey = `ff:hook-rl-ip:${webhookId}:${ip}:${minute}`;
    try {
      const [[, hookCount], [, ipCount]] = (await this.redis
        .multi()
        .incr(hookKey)
        .expire(hookKey, 120)
        .incr(ipKey)
        .expire(ipKey, 120)
        .exec()
        .then((r) => [r![0], r![2]])) as [[unknown, number], [unknown, number]];
      if (hookCount > config.rateLimitPerMinute) return 'per-hook limit';
      if (ipCount > this.config.hooks.perIpPerMinute) return 'per-IP limit';
      return null;
    } catch (err) {
      this.logger.warn(
        { error: (err as Error).message },
        'Webhook rate limit check failed (allowed)',
      );
      return null;
    }
  }

  private async overDailyCap(workspaceId: string): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    const key = `ff:hook-day:${workspaceId}:${day}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, 2 * 86_400);
      return count > this.config.hooks.dailyCapPerWorkspace;
    } catch {
      return false;
    }
  }
}

const header = (req: InboundHookRequest, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};
