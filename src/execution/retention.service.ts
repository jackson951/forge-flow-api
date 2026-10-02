import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../infrastructure/prisma/prisma.service';

export interface RetentionResult {
  webhookDeliveriesDeleted: number;
  runsTrimmed: number;
  runsDeleted: number;
  /** True when a category hit RETENTION_MAX_BATCHES; the next tick continues. */
  more: boolean;
}

/**
 * History retention (Part 21, FR-21.8), run by the maintenance queue in the worker:
 *
 * - webhook deliveries older than RETENTION_WEBHOOK_DELIVERY_DAYS are deleted (runs keep
 *   their own copy of the trigger input; their link to the delivery becomes NULL);
 * - finished runs older than RETENTION_STEP_PAYLOAD_DAYS lose their steps' stored input and
 *   output (status, timing and errors stay) and are marked `payloadsTrimmedAt`;
 * - finished runs older than RETENTION_RUN_DAYS are deleted with their steps.
 *
 * Tenant safety: rows are selected by age and status only — never by anything a request
 * supplies — so one statement covers all workspaces alike. Each statement handles at most
 * RETENTION_BATCH_SIZE rows (short transactions, short locks); a tick runs at most
 * RETENTION_MAX_BATCHES per category. Runs that are QUEUED or RUNNING are never touched.
 */
@Injectable()
export class RetentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RetentionService.name);
  }

  async run(now = new Date()): Promise<RetentionResult> {
    const { webhookDeliveryMs, stepPayloadMs, runMs, batchSize, maxBatches } =
      this.config.retention;
    const before = (ms: number) => new Date(now.getTime() - ms);
    const started = Date.now();

    // Runs first: deleting them makes the trim and delivery passes smaller.
    const runs = await this.batched(maxBatches, batchSize, () =>
      this.deleteRuns(before(runMs), batchSize),
    );
    const trimmed = await this.batched(maxBatches, batchSize, () =>
      this.trimPayloads(before(stepPayloadMs), batchSize, now),
    );
    const deliveries = await this.batched(maxBatches, batchSize, () =>
      this.deleteDeliveries(before(webhookDeliveryMs), batchSize),
    );

    const result: RetentionResult = {
      webhookDeliveriesDeleted: deliveries.count,
      runsTrimmed: trimmed.count,
      runsDeleted: runs.count,
      more: deliveries.more || trimmed.more || runs.more,
    };
    if (result.webhookDeliveriesDeleted || result.runsTrimmed || result.runsDeleted) {
      this.logger.info({ ...result, durationMs: Date.now() - started }, 'Retention applied');
    }
    return result;
  }

  /** Repeats `step` until a batch is not full or the batch budget is used up. */
  private async batched(
    maxBatches: number,
    batchSize: number,
    step: () => Promise<number>,
  ): Promise<{ count: number; more: boolean }> {
    let count = 0;
    for (let i = 0; i < maxBatches; i++) {
      const n = await step();
      count += n;
      if (n < batchSize) return { count, more: false };
    }
    return { count, more: true };
  }

  private deleteDeliveries(cutoff: Date, limit: number): Promise<number> {
    return this.prisma.$executeRaw`
      DELETE FROM "WebhookDelivery"
      WHERE id IN (
        SELECT id FROM "WebhookDelivery"
        WHERE "receivedAt" < ${cutoff}
        ORDER BY "receivedAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )`;
  }

  /** Clears step input/output of a batch of old finished runs, then marks the runs. */
  private trimPayloads(cutoff: Date, limit: number, now: Date): Promise<number> {
    return this.prisma.$executeRaw`
      WITH batch AS (
        SELECT id FROM "WorkflowRun"
        WHERE "payloadsTrimmedAt" IS NULL
          AND "createdAt" < ${cutoff}
          AND status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
        ORDER BY "createdAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ), steps AS (
        UPDATE "StepRun"
        SET "sanitizedInput" = NULL, "sanitizedOutput" = NULL, "updatedAt" = ${now}
        WHERE "runId" IN (SELECT id FROM batch)
          AND ("sanitizedInput" IS NOT NULL OR "sanitizedOutput" IS NOT NULL)
      )
      UPDATE "WorkflowRun" r
      SET "payloadsTrimmedAt" = ${now}
      FROM batch
      WHERE r.id = batch.id`;
  }

  /** Steps go with their run (ON DELETE CASCADE); retries keep existing (link set NULL). */
  private deleteRuns(cutoff: Date, limit: number): Promise<number> {
    return this.prisma.$executeRaw`
      DELETE FROM "WorkflowRun"
      WHERE id IN (
        SELECT id FROM "WorkflowRun"
        WHERE "createdAt" < ${cutoff}
          AND status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
        ORDER BY "createdAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )`;
  }
}
