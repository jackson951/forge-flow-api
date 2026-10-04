import { Injectable } from '@nestjs/common';
import { Prisma, ScheduleKind, TriggerSource, WorkflowStatus } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { AppConfigService } from '../config/app-config.service';
import { dueOccurrence } from '../engine/schedule/schedule';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { PollQueue } from '../infrastructure/queue/poll-queue.service';
import { QueueBackpressure } from '../infrastructure/queue/queue-backpressure.service';
import { RunQueue } from '../infrastructure/queue/run-queue.service';

export interface ScheduleTickResult {
  fired: number;
  duplicates: number;
  /** Occurrences not run because of the misfire policy (FR-23.7). */
  skipped: number;
  deactivated: number;
  /** http.poll occurrences handed to the poll queue (Part 24). */
  polls: number;
}

/** Trigger input of a scheduled run: built by the system, never from user input (FR-23.9). */
export interface ScheduleTriggerInput {
  triggerType: 'SCHEDULE';
  scheduledFor: string;
  triggeredAt: string;
  timezone: string;
  scheduleId: string;
}

interface DueRow {
  id: string;
  workspaceId: string;
  workflowId: string;
  workflowVersionId: string;
  cron: string;
  timezone: string;
  nextRunAt: Date;
  dbNow: Date;
  workflowStatus: WorkflowStatus;
  activeVersionId: string | null;
  workflowWorkspaceId: string;
  kind: ScheduleKind;
}

type Outcome =
  | { kind: 'fired' | 'duplicate'; skipped: number; enqueue?: Record<string, unknown> }
  | { kind: 'skipped'; skipped: number }
  | { kind: 'poll'; skipped: number; occurrence: string; scheduleId: string }
  | { kind: 'deactivated' };

/** One occurrence = one run: the idempotency key is the occurrence's identity. */
export const occurrenceKey = (scheduleId: string, occurrence: Date) =>
  `schedule:${scheduleId}:${occurrence.toISOString()}`;

/**
 * Schedule trigger evaluator (Part 23), run by the maintenance queue in the worker. It never
 * executes workflows: it records due occurrences as QUEUED runs and enqueues them, exactly
 * like a webhook does.
 *
 * Correctness comes from the database only (FR-23.6):
 * - each due schedule is handled in its own short transaction that locks its row with
 *   `FOR UPDATE SKIP LOCKED`, so workers share the work without waiting for each other;
 * - the run insert and the `nextRunAt` advance commit together;
 * - `WorkflowRun(workspaceId, idempotencyKey)` is unique and the key is
 *   `schedule:<id>:<occurrence>`, so a retried tick or any race creates at most one run;
 * - "due" is judged by the database clock (`now()`), never a worker's clock.
 * The enqueue happens after the commit; if it fails, the run stays QUEUED for the sweeper.
 */
@Injectable()
export class ScheduleEvaluator {
  private readonly workerId = `${hostname()}:${process.pid}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: RunQueue,
    private readonly backpressure: QueueBackpressure,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
    private readonly polls: PollQueue,
  ) {
    this.logger.setContext(ScheduleEvaluator.name);
  }

  async tick(): Promise<ScheduleTickResult> {
    const result: ScheduleTickResult = {
      fired: 0,
      duplicates: 0,
      skipped: 0,
      deactivated: 0,
      polls: 0,
    };
    for (let i = 0; i < this.config.schedule.batchSize; i++) {
      const outcome = await this.evaluateNext();
      if (!outcome) break;
      if (outcome.kind === 'deactivated') {
        result.deactivated++;
        continue;
      }
      result.skipped += outcome.skipped;
      if (outcome.kind === 'fired') result.fired++;
      if (outcome.kind === 'duplicate') result.duplicates++;
      if (outcome.kind === 'poll') result.polls++;
    }
    // Scheduled runs are never refused, but a backlog is reported like for webhooks.
    if (result.fired) await this.backpressure.observe('schedule');
    if (result.fired || result.duplicates || result.skipped || result.deactivated || result.polls) {
      this.logger.info({ ...result, workerId: this.workerId }, 'Schedule tick');
    }
    return result;
  }

  /** Handles the most overdue unlocked schedule; null when none is due. */
  async evaluateNext(): Promise<Outcome | null> {
    const outcome = await this.prisma.$transaction((tx) => this.claimAndFire(tx));
    if (outcome?.kind === 'fired' && outcome.enqueue) await this.enqueue(outcome.enqueue);
    if (outcome?.kind === 'poll') {
      const { scheduleId, occurrence } = outcome;
      await this.polls.enqueue({ scheduleId, occurrence }).catch((err: Error) =>
        // Polling is state-based: the next occurrence catches up on whatever is new.
        this.logger.warn(
          { scheduleId, occurrence, error: err.message },
          'Poll enqueue failed; skipped',
        ),
      );
    }
    return outcome;
  }

  private async claimAndFire(tx: Prisma.TransactionClient): Promise<Outcome | null> {
    const [due] = await tx.$queryRaw<DueRow[]>`
      SELECT s.id, s."workspaceId", s."workflowId", s."workflowVersionId", s.cron, s.timezone,
             s."nextRunAt", now() AS "dbNow", w.status AS "workflowStatus",
             w."activeVersionId", w."workspaceId" AS "workflowWorkspaceId", s.kind
      FROM "WorkflowSchedule" s
      JOIN "Workflow" w ON w.id = s."workflowId"
      WHERE s.active AND s."nextRunAt" <= now()
      ORDER BY s."nextRunAt", s.id
      LIMIT 1
      FOR UPDATE OF s SKIP LOCKED`;
    if (!due) return null;
    const ids = { scheduleId: due.id, workflowId: due.workflowId, workspaceId: due.workspaceId };

    // FR-23.10: only a published workflow whose active version is this schedule's, in the
    // schedule's own workspace, may run. Anything else stops the schedule.
    if (
      due.workflowStatus !== WorkflowStatus.PUBLISHED ||
      due.activeVersionId !== due.workflowVersionId ||
      due.workflowWorkspaceId !== due.workspaceId
    ) {
      return this.deactivate(tx, due, 'the workflow is no longer published with this version');
    }

    let occurrence: ReturnType<typeof dueOccurrence>;
    try {
      occurrence = dueOccurrence(
        due,
        due.nextRunAt,
        due.dbNow,
        this.config.schedule.misfireGraceMs,
      );
    } catch (err) {
      // E.g. the timezone is no longer known to this runtime.
      return this.deactivate(
        tx,
        due,
        `the schedule cannot be evaluated: ${(err as Error).message}`,
      );
    }

    const skipped = occurrence.skipped + (occurrence.skippedBeforeWindow ? 1 : 0);
    if (skipped) {
      this.logger.warn(
        {
          ...ids,
          skipped: occurrence.skipped,
          skippedBeforeWindow: occurrence.skippedBeforeWindow,
          dueSince: due.nextRunAt.toISOString(),
          graceMs: this.config.schedule.misfireGraceMs,
          workerId: this.workerId,
        },
        'Missed schedule occurrences skipped (only the latest within the grace window runs)',
      );
    }

    // http.poll (Part 24): the occurrence is a poll, run by the poll queue; items become runs.
    if (due.kind === ScheduleKind.POLL) {
      await tx.workflowSchedule.update({
        where: { id: due.id },
        data: {
          nextRunAt: occurrence.next,
          active: occurrence.next !== null,
          ...(occurrence.fire && { lastOccurrenceAt: occurrence.fire }),
        },
      });
      return occurrence.fire
        ? { kind: 'poll', skipped, scheduleId: due.id, occurrence: occurrence.fire.toISOString() }
        : { kind: 'skipped', skipped };
    }

    let runId: string | null = null;
    let correlationId: string | null = null;
    if (occurrence.fire) {
      const fire = occurrence.fire;
      const candidate = randomUUID();
      correlationId = randomUUID();
      const triggerInput: ScheduleTriggerInput = {
        triggerType: 'SCHEDULE',
        scheduledFor: fire.toISOString(),
        triggeredAt: due.dbNow.toISOString(),
        timezone: due.timezone,
        scheduleId: due.id,
      };
      // ON CONFLICT DO NOTHING: a duplicate must not abort the transaction.
      const { count } = await tx.workflowRun.createMany({
        data: [
          {
            id: candidate,
            workspaceId: due.workspaceId,
            workflowId: due.workflowId,
            workflowVersionId: due.workflowVersionId,
            triggerSource: TriggerSource.SCHEDULE,
            idempotencyKey: occurrenceKey(due.id, fire),
            triggerInput: triggerInput as unknown as Prisma.InputJsonObject,
            correlationId,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 1) {
        runId = candidate;
      } else {
        this.logger.info(
          { ...ids, scheduledFor: fire.toISOString(), workerId: this.workerId },
          'Schedule occurrence already has a run; duplicate suppressed',
        );
      }
    }

    await tx.workflowSchedule.update({
      where: { id: due.id },
      data: {
        nextRunAt: occurrence.next,
        active: occurrence.next !== null,
        ...(occurrence.fire && { lastOccurrenceAt: occurrence.fire }),
        ...(runId && { lastRunId: runId }),
      },
    });
    if (!occurrence.next) {
      this.logger.warn(
        { ...ids, workerId: this.workerId },
        'Schedule deactivated: it never runs again',
      );
    }

    if (!occurrence.fire) return { kind: 'skipped', skipped };
    if (!runId) return { kind: 'duplicate', skipped };
    return {
      kind: 'fired',
      skipped,
      enqueue: {
        ...ids,
        runId,
        correlationId,
        scheduledFor: occurrence.fire.toISOString(),
        lagMs: due.dbNow.getTime() - occurrence.fire.getTime(),
      },
    };
  }

  private async deactivate(
    tx: Prisma.TransactionClient,
    due: DueRow,
    reason: string,
  ): Promise<Outcome> {
    await tx.workflowSchedule.update({
      where: { id: due.id },
      data: { active: false, nextRunAt: null },
    });
    this.logger.warn(
      {
        scheduleId: due.id,
        workflowId: due.workflowId,
        workspaceId: due.workspaceId,
        reason,
        workerId: this.workerId,
      },
      'Schedule deactivated',
    );
    return { kind: 'deactivated' };
  }

  /** After the commit. A failure leaves the run QUEUED; the sweeper re-enqueues it. */
  private async enqueue(fields: Record<string, unknown>): Promise<void> {
    const runId = fields.runId as string;
    try {
      await this.queue.enqueue(runId, { reason: 'schedule', correlationId: fields.correlationId });
      this.logger.info(
        { ...fields, enqueuedAt: new Date().toISOString(), workerId: this.workerId },
        'Schedule occurrence fired',
      );
    } catch (err) {
      this.logger.warn(
        { ...fields, error: (err as Error).message, workerId: this.workerId },
        'Schedule occurrence recorded but not enqueued; the sweeper will pick the run up',
      );
    }
  }
}
