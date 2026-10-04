import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ConnectionStatus,
  Prisma,
  TriggerSource,
  WebhookDeliveryStatus,
  WorkflowStatus,
} from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { QueueBackpressure } from '../../infrastructure/queue/queue-backpressure.service';
import { RunQueue } from '../../infrastructure/queue/run-queue.service';
import {
  InboundWebhook,
  NormalizedEvent,
  WEBHOOK_PROVIDERS,
  WebhookProvider,
} from './providers/webhook-provider';

export const MAX_EVENT_DATA_BYTES = 256 * 1024;
const MAX_DELIVERY_ID_LENGTH = 200;
/** Prisma's defaults are 2 s / 5 s. */
const INTAKE_TX_MAX_WAIT_MS = 5_000;
const INTAKE_TX_TIMEOUT_MS = 8_000;

export type IntakeResult =
  | { accepted: true; duplicate: false; deliveryId: string; runs: number }
  | { accepted: true; duplicate: true; deliveryId: string };

/**
 * Generic webhook pipeline (docs/backend/09-WEBHOOK-PLATFORM.md):
 *
 *   verify signature → delivery id → normalise → [tx: store delivery (unique) → match
 *   triggers → create runs (idempotency key per workflow)] → enqueue → 202
 *
 * - Nothing is written for an invalid signature.
 * - The (provider, deliveryId) unique constraint — not a prior SELECT — detects duplicates,
 *   including concurrent ones. A duplicate creates no runs.
 * - No outbound calls; all work happens in the worker.
 */
@Injectable()
export class WebhookIntakeService {
  private readonly providers: Map<string, WebhookProvider>;

  constructor(
    @Inject(WEBHOOK_PROVIDERS) providers: WebhookProvider[],
    private readonly prisma: PrismaService,
    private readonly queue: RunQueue,
    private readonly backpressure: QueueBackpressure,
    private readonly logger: PinoLogger,
  ) {
    this.providers = new Map(providers.map((p) => [p.slug, p]));
    this.logger.setContext(WebhookIntakeService.name);
  }

  async receive(
    slug: string,
    request: InboundWebhook,
    correlationId?: string,
  ): Promise<IntakeResult> {
    const started = Date.now();
    const provider = this.providers.get(slug);
    if (!provider?.isEnabled()) throw new NotFoundException('Unknown webhook provider');

    const verification = provider.verify(request);
    if (!verification.ok) {
      this.logger.warn({ provider: slug, reason: verification.reason }, 'Webhook rejected');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const deliveryId = provider.deliveryId(request);
    if (!deliveryId || deliveryId.length > MAX_DELIVERY_ID_LENGTH) {
      throw new BadRequestException('Missing or invalid delivery id');
    }

    const event = provider.normalize(request);
    if (event && Buffer.byteLength(JSON.stringify(event.data), 'utf8') > MAX_EVENT_DATA_BYTES) {
      throw new PayloadTooLargeException('Event data is too large');
    }
    const eventName = provider.eventName(request);

    let runIds: string[];
    try {
      runIds = await this.prisma.$transaction(
        (tx) => this.record(tx, provider, deliveryId, eventName, event, correlationId),
        // Under a burst the pool can be busy for a moment. Waiting (well inside providers'
        // ~10 s delivery timeout) beats a 500: GitHub does not redeliver on its own (Part 21).
        { maxWait: INTAKE_TX_MAX_WAIT_MS, timeout: INTAKE_TX_TIMEOUT_MS },
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.info(
          { provider: slug, deliveryId, eventName },
          'Duplicate webhook delivery ignored',
        );
        return { accepted: true, duplicate: true, deliveryId };
      }
      throw err;
    }

    // Deliveries are always accepted, even under backpressure (the database is the buffer);
    // a backlog only raises the alert.
    if (runIds.length) await this.backpressure.observe();
    for (const runId of runIds) {
      await this.queue
        .enqueue(runId, { correlationId, provider: slug, deliveryId })
        .catch((err: Error) =>
          this.logger.warn(
            { runId, error: err.message },
            'Enqueue failed; the sweeper will pick the run up',
          ),
        );
    }
    this.logger.info(
      {
        provider: slug,
        deliveryId,
        eventName,
        runs: runIds.length,
        durationMs: Date.now() - started,
      },
      'Webhook accepted',
    );
    return { accepted: true, duplicate: false, deliveryId, runs: runIds.length };
  }

  private async record(
    tx: Prisma.TransactionClient,
    provider: WebhookProvider,
    deliveryId: string,
    eventName: string,
    event: NormalizedEvent | null,
    correlationId: string | undefined,
  ): Promise<string[]> {
    // Throws P2002 for a delivery we have already seen; the whole transaction is discarded.
    const delivery = await tx.webhookDelivery.create({
      data: {
        provider: provider.key,
        deliveryId,
        eventType: event?.eventType ?? eventName,
        payload: event ? (event as unknown as Prisma.InputJsonObject) : Prisma.JsonNull,
      },
      select: { id: true },
    });

    const triggers = event
      ? await tx.workflowTrigger.findMany({
          where: {
            provider: provider.key,
            eventType: { in: event.eventTypes ?? [event.eventType] },
            resourceKey: event.resourceKey,
            workflow: { status: WorkflowStatus.PUBLISHED },
          },
          select: {
            workspaceId: true,
            workflowId: true,
            workflowVersionId: true,
            eventType: true,
            connectionId: true,
            filter: true,
            workflow: { select: { activeVersionId: true } },
            connection: { select: { externalAccountId: true, status: true, workspaceId: true } },
          },
        })
      : [];
    const matches = triggers.filter(
      (t) =>
        // Routing rows always follow the active version; this guards against any stale row.
        t.workflowVersionId === t.workflow.activeVersionId &&
        // Account-bound providers: the event's account must be this workspace's connection.
        (event!.accountId === undefined ||
          (t.connection?.externalAccountId === event!.accountId &&
            t.connection.status === ConnectionStatus.CONNECTED &&
            t.connection.workspaceId === t.workspaceId)) &&
        // Connection-bound providers (Jira): only the connection that received it.
        (event!.connectionId === undefined ||
          (t.connectionId === event!.connectionId &&
            t.connection?.status === ConnectionStatus.CONNECTED &&
            t.connection.workspaceId === t.workspaceId)) &&
        (provider.matches ? provider.matches(event!, t.filter, t.eventType) : true),
    );

    let connectionsUpdated = 0;
    if (event?.connectionStatus && event.accountId) {
      const updated = await tx.integrationConnection.updateMany({
        where: { provider: provider.key, externalAccountId: event.accountId },
        data: { status: event.connectionStatus },
      });
      connectionsUpdated = updated.count;
    }

    const runIds: string[] = [];
    for (const match of matches) {
      const run = await tx.workflowRun.create({
        data: {
          workspaceId: match.workspaceId,
          workflowId: match.workflowId,
          workflowVersionId: match.workflowVersionId,
          triggerSource: TriggerSource.WEBHOOK,
          idempotencyKey: `${provider.key}:${deliveryId}:${match.workflowId}`,
          webhookDeliveryId: delivery.id,
          triggerInput: event!.data as Prisma.InputJsonObject,
          correlationId,
        },
        select: { id: true },
      });
      runIds.push(run.id);
    }

    const workspaces = new Set(matches.map((m) => m.workspaceId));
    await tx.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status:
          runIds.length || connectionsUpdated
            ? WebhookDeliveryStatus.PROCESSED
            : WebhookDeliveryStatus.IGNORED,
        workspaceId: workspaces.size === 1 ? [...workspaces][0] : null,
        processedAt: new Date(),
      },
    });
    return runIds;
  }
}
