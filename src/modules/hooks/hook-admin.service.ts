import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  IntegrationProviderKey,
  Prisma,
  TriggerSource,
  WebhookDeliveryStatus,
  WorkflowStatus,
  WorkspaceRole,
} from '@prisma/client';
import Redis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RunQueue } from '../../infrastructure/queue/run-queue.service';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.module';
import { AuditService } from '../audit/audit.service';
import { webhookTriggerConfigSchema } from './hook-config';
import { captureKeys } from './hook-intake.service';
import {
  hashHookId,
  HookProvisioner,
  newHookId,
  newHookSecret,
  secretHint,
} from './hook-provisioner.service';

const LISTEN_SECONDS = 600;
const HOUR = 3_600_000;

export interface WebhookDetails {
  provisioned: boolean;
  active?: boolean;
  url?: string;
  path?: string;
  verificationMode?: string;
  secretHint?: string | null;
  /** Only on the first read by an admin after the secret was generated. */
  secret?: string;
  previousSecretExpiresAt?: Date | null;
  previousUrlExpiresAt?: Date | null;
  listening?: boolean;
}

/** Delivery log entry (FR-24.15): never the payload's secrets — status, reason, sizes, links. */
const DELIVERY_SELECT = {
  id: true,
  deliveryId: true,
  status: true,
  reason: true,
  receivedAt: true,
  sizeBytes: true,
  sourceIp: true,
  duplicateCount: true,
  lastDuplicateAt: true,
  runs: { select: { id: true, status: true }, orderBy: { createdAt: 'asc' as const }, take: 1 },
} satisfies Prisma.WebhookDeliverySelect;

/**
 * Workspace-side management of a workflow's generic webhook (Part 24): URL and status,
 * secret / URL rotation with grace (FR-24.9), delivery log and replay, test capture (FR-24.15).
 * Every query is scoped by the guarded workspace id.
 */
@Injectable()
export class HookAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provisioner: HookProvisioner,
    private readonly queue: RunQueue,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(HookAdminService.name);
  }

  async details(
    access: WorkspaceAccess,
    workflowId: string,
    baseUrl: string,
  ): Promise<WebhookDetails> {
    await this.workflow(access.workspaceId, workflowId);
    const hook = await this.prisma.workflowWebhook.findFirst({
      where: { workflowId, workspaceId: access.workspaceId },
    });
    if (!hook) return { provisioned: false };
    const isAdmin = access.role !== WorkspaceRole.MEMBER;
    let secret: string | undefined;
    // "Shown once": the first admin read after generation reveals it, atomically.
    if (isAdmin && hook.encryptedSecret && !hook.secretRevealedAt) {
      const claimed = await this.prisma.workflowWebhook.updateMany({
        where: { id: hook.id, secretRevealedAt: null },
        data: { secretRevealedAt: new Date() },
      });
      if (claimed.count === 1)
        secret = this.provisioner.open(hook.id, 'secret', hook.encryptedSecret);
    }
    const parsed = webhookTriggerConfigSchema.safeParse(hook.config ?? {});
    const listening = await this.redis.exists(captureKeys(workflowId).listening).catch(() => 0);
    return {
      provisioned: true,
      active: hook.active,
      ...this.urls(hook.id, hook.encryptedHookId, baseUrl),
      verificationMode: hook.config && parsed.success ? parsed.data.verification.mode : undefined,
      secretHint: hook.secretHint,
      ...(secret && { secret }),
      previousSecretExpiresAt: active(hook.previousSecretExpiresAt),
      previousUrlExpiresAt: active(hook.previousHookIdExpiresAt),
      listening: listening === 1,
    };
  }

  /** New secret (generated, or the sender's own); the old one stays valid for the grace period. */
  async rotateSecret(
    access: WorkspaceAccess,
    workflowId: string,
    input: { secret?: string; graceHours?: number },
  ) {
    const hook = await this.hook(access.workspaceId, workflowId);
    const secret = input.secret ?? newHookSecret();
    if (secret.length < 16 || /[\r\n\0]/.test(secret)) {
      throw new UnprocessableEntityException(
        'The secret must be at least 16 characters, without line breaks',
      );
    }
    const graceMs = (input.graceHours ?? this.config.hooks.rotationGraceHours) * HOUR;
    const previousSecretExpiresAt =
      hook.encryptedSecret && graceMs > 0 ? new Date(Date.now() + graceMs) : null;
    await this.prisma.$transaction(async (tx) => {
      await tx.workflowWebhook.update({
        where: { id: hook.id },
        data: {
          encryptedSecret: this.provisioner.seal(hook.id, 'secret', secret),
          secretHint: secretHint(secret),
          // A secret the admin chose is already known to them; a generated one is shown now.
          secretRevealedAt: new Date(),
          previousEncryptedSecret:
            previousSecretExpiresAt && hook.encryptedSecret
              ? this.provisioner.seal(
                  hook.id,
                  'previousSecret',
                  this.provisioner.open(hook.id, 'secret', hook.encryptedSecret),
                )
              : null,
          previousSecretExpiresAt,
          rotatedAt: new Date(),
        },
      });
      await this.record(tx, access, workflowId, 'webhook.secret_rotated', {
        graceHours: graceMs / HOUR,
        providedBySender: Boolean(input.secret),
      });
    });
    return {
      secret: input.secret ? undefined : secret,
      secretHint: secretHint(secret),
      previousSecretExpiresAt,
    };
  }

  /** New URL; the old one keeps working for the grace period (then 404). */
  async rotateUrl(
    access: WorkspaceAccess,
    workflowId: string,
    input: { graceHours?: number },
    baseUrl: string,
  ) {
    const hook = await this.hook(access.workspaceId, workflowId);
    const hookId = newHookId();
    const graceMs = (input.graceHours ?? this.config.hooks.rotationGraceHours) * HOUR;
    const previousUrlExpiresAt = graceMs > 0 ? new Date(Date.now() + graceMs) : null;
    const encryptedHookId = this.provisioner.seal(hook.id, 'hookId', hookId);
    await this.prisma.$transaction(async (tx) => {
      await tx.workflowWebhook.update({
        where: { id: hook.id },
        data: {
          hookIdHash: hashHookId(hookId),
          encryptedHookId,
          previousHookIdHash: previousUrlExpiresAt ? hook.hookIdHash : null,
          previousHookIdExpiresAt: previousUrlExpiresAt,
          rotatedAt: new Date(),
        },
      });
      await this.record(tx, access, workflowId, 'webhook.url_rotated', {
        graceHours: graceMs / HOUR,
      });
    });
    return { ...this.urls(hook.id, encryptedHookId, baseUrl), previousUrlExpiresAt };
  }

  async deliveries(access: WorkspaceAccess, workflowId: string, limit = 20, before?: string) {
    await this.workflow(access.workspaceId, workflowId);
    const cursor = before
      ? await this.prisma.webhookDelivery.findFirst({
          where: { id: before, workflowId, workspaceId: access.workspaceId },
          select: { receivedAt: true, id: true },
        })
      : null;
    const rows = await this.prisma.webhookDelivery.findMany({
      where: {
        workflowId,
        workspaceId: access.workspaceId,
        provider: IntegrationProviderKey.WEBHOOK,
        ...(cursor && {
          OR: [
            { receivedAt: { lt: cursor.receivedAt } },
            { receivedAt: cursor.receivedAt, id: { lt: cursor.id } },
          ],
        }),
      },
      select: DELIVERY_SELECT,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const items = rows.slice(0, limit).map(({ runs, deliveryId, ...row }) => ({
      ...row,
      // The sender's id (or ours), without the internal hook prefix.
      deliveryId: deliveryId.replace(/^[^:]+:(src:|gen:|rejected:)/, ''),
      run: runs[0] ?? null,
    }));
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit && last ? last.id : null };
  }

  /** A new run from a stored delivery (marked as a replay), on the current active version. */
  async replay(
    access: WorkspaceAccess,
    workflowId: string,
    deliveryRowId: string,
    correlationId?: string,
  ) {
    const hook = await this.hook(access.workspaceId, workflowId);
    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryRowId, workflowId, workspaceId: access.workspaceId },
      select: { id: true, status: true, payload: true },
    });
    if (!delivery) throw new NotFoundException('Delivery not found');
    if (delivery.status === WebhookDeliveryStatus.REJECTED || !delivery.payload) {
      throw new ConflictException('Rejected deliveries cannot be replayed');
    }
    const workflow = await this.workflow(access.workspaceId, workflowId);
    if (!hook.active || workflow.status !== WorkflowStatus.PUBLISHED || !workflow.activeVersionId) {
      throw new ConflictException('Publish the workflow with a webhook trigger before replaying');
    }
    const run = await this.prisma.$transaction(async (tx) => {
      const created = await tx.workflowRun.create({
        data: {
          workspaceId: access.workspaceId,
          workflowId,
          workflowVersionId: workflow.activeVersionId!,
          triggerSource: TriggerSource.WEBHOOK,
          idempotencyKey: `replay:${delivery.id}:${randomUUID()}`,
          webhookDeliveryId: delivery.id,
          triggerInput: {
            ...(delivery.payload as Prisma.JsonObject),
            replayOfDeliveryId: delivery.id,
          } as Prisma.InputJsonObject,
          correlationId,
        },
        select: { id: true, status: true },
      });
      await this.record(tx, access, workflowId, 'webhook.delivery_replayed', {
        deliveryId: delivery.id,
        runId: created.id,
      });
      return created;
    });
    await this.queue
      .enqueue(run.id, { correlationId, replayOf: delivery.id })
      .catch((err: Error) =>
        this.logger.warn(
          { runId: run.id, error: err.message },
          'Enqueue failed; the sweeper will pick the run up',
        ),
      );
    return { runId: run.id, status: run.status };
  }

  /**
   * "Listen for a test event" (FR-24.15): for 10 minutes the next delivery to the URL of a
   * workflow that is not live is captured (no run) so the editor can offer its fields.
   */
  async listen(access: WorkspaceAccess, workflowId: string, baseUrl: string) {
    await this.workflow(access.workspaceId, workflowId);
    const hook = await this.provisioner.ensure({ id: workflowId, workspaceId: access.workspaceId });
    const keys = captureKeys(workflowId);
    await this.redis.multi().del(keys.data).set(keys.listening, '1', 'EX', LISTEN_SECONDS).exec();
    return {
      ...this.urls(hook.id, hook.encryptedHookId, baseUrl),
      expiresAt: new Date(Date.now() + LISTEN_SECONDS * 1_000),
    };
  }

  async captured(access: WorkspaceAccess, workflowId: string) {
    await this.workflow(access.workspaceId, workflowId);
    const keys = captureKeys(workflowId);
    const [data, listening] = await Promise.all([
      this.redis.get(keys.data),
      this.redis.exists(keys.listening),
    ]);
    return {
      listening: listening === 1,
      event: data ? (JSON.parse(data) as unknown) : null,
    };
  }

  private urls(webhookId: string, encryptedHookId: string, baseUrl: string) {
    const hookId = this.provisioner.open(webhookId, 'hookId', encryptedHookId);
    const path = `/${this.config.get('API_PREFIX')}/v1/webhooks/hooks/${hookId}`;
    const base = (this.config.hooks.publicApiUrl ?? baseUrl).replace(/\/+$/, '');
    return { path, url: `${base}${path}` };
  }

  private async workflow(workspaceId: string, workflowId: string) {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, workspaceId },
      select: { id: true, status: true, activeVersionId: true },
    });
    if (!workflow) throw new NotFoundException('Workflow not found');
    return workflow;
  }

  private async hook(workspaceId: string, workflowId: string) {
    await this.workflow(workspaceId, workflowId);
    const hook = await this.prisma.workflowWebhook.findFirst({
      where: { workflowId, workspaceId },
    });
    if (!hook) throw new NotFoundException('This workflow has no webhook yet');
    return hook;
  }

  private record(
    tx: Prisma.TransactionClient,
    access: WorkspaceAccess,
    workflowId: string,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.record(
      {
        action,
        workspaceId: access.workspaceId,
        actorUserId: access.userId,
        targetType: 'Workflow',
        targetId: workflowId,
        metadata: metadata as Prisma.InputJsonObject,
      },
      tx,
    );
  }
}

const active = (date: Date | null) => (date && date.getTime() > Date.now() ? date : null);
