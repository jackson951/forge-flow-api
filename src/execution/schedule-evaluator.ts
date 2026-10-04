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

/** Due schedules claimed per transaction. */
export const CLAIM_BATCH = 50;

/**
 * A batch writes up to CLAIM_BATCH runs and advances; Prisma's 5 s default aborted it on a
 * contended database (Part 27). An abort commits nothing: the schedules stay due and the next tick
 * retries them. Other evaluators skip the locked rows meanwhile.
 */
const CLAIM_TX = { maxWait: 10_000, timeout: 30_000 };

/** What one claimed schedule turns into (decided in memory, written per batch). */
interface Plan {
  due: DueRow;
  outcome: Outcome;
  run?: Prisma.WorkflowRunCreateManyInput;
  update: { next: Date | null; active: boolean; occurrence: Date | null };
}

/**
 * Schedule trigger evaluator (Part 23), run by the maintenance queue in the worker. It never
 * executes workflows: it records due occurrences as QUEUED runs and enqueues them, exactly
 * like a webhook does.
 *
 * Correctness comes from the database only (FR-23.6):
 * - due schedules are claimed in batches of up to CLAIM_BATCH per short transaction, each row
 *   locked with `FOR UPDATE SKIP LOCKED`, so workers share the work without waiting for each
 *   other (Part 27: one commit per batch instead of per schedule — the evaluator was bound by
 *   per-transaction overhead at ~23 schedules/s with 3 evaluators);
 * - the runs insert and the `nextRunAt` advances commit together;
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
    let handled = 0;
    while (handled < this.config.schedule.batchSize) {
      const outcomes = await this.evaluateBatch(
        Math.min(CLAIM_BATCH, this.config.schedule.batchSize - handled),
      );
      if (!outcomes.length) break;
      handled += outcomes.length;
      for (const outcome of outcomes) {
        if (outcome.kind === 'deactivated') {
          result.deactivated++;
          continue;
        }
        result.skipped += outcome.skipped;
        if (outcome.kind === 'fired') result.fired++;
        if (outcome.kind === 'duplicate') result.duplicates++;
        if (outcome.kind === 'poll') result.polls++;
      }
    }
    // Scheduled runs are never refused, but a backlog is reported like for webhooks.
    if (result.fired) await this.backpressure.observe('schedule');
    if (result.fired || result.duplicates || result.skipped || result.deactivated || result.polls) {
      this.logger.info({ ...result, workerId: this.workerId }, 'Schedule tick');
    }
    return result;
  }

  /** Claims up to `limit` due schedules in one transaction; empty when none is due. */
  async evaluateBatch(limit = CLAIM_BATCH): Promise<Outcome[]> {
    const outcomes = await this.prisma.$transaction((tx) => this.claimAndFire(tx, limit), CLAIM_TX);
    for (const outcome of outcomes) {
      if (outcome.kind === 'fired' && outcome.enqueue) await this.enqueue(outcome.enqueue);
      if (outcome.kind === 'poll') {
        const { scheduleId, occurrence } = outcome;
        await this.polls.enqueue({ scheduleId, occurrence }).catch((err: Error) =>
          // Polling is state-based: the next occurrence catches up on whatever is new.
          this.logger.warn(
            { scheduleId, occurrence, error: err.message },
            'Poll enqueue failed; skipped',
          ),
        );
      }
    }
    return outcomes;
  }

  private async claimAndFire(tx: Prisma.TransactionClient, limit: number): Promise<Outcome[]> {
    const claimed = await tx.$queryRaw<DueRow[]>`
      SELECT s.id, s."workspaceId", s."workflowId", s."workflowVersionId", s.cron, s.timezone,
             s."nextRunAt", now() AS "dbNow", w.status AS "workflowStatus",
             w."activeVersionId", w."workspaceId" AS "workflowWorkspaceId", s.kind
      FROM "WorkflowSchedule" s
      JOIN "Workflow" w ON w.id = s."workflowId"
      WHERE s.active AND s."nextRunAt" <= now()
      ORDER BY s."nextRunAt", s.id
      LIMIT ${limit}
      FOR UPDATE OF s SKIP LOCKED`;
    if (!claimed.length) return [];
    const plans = claimed.map((due) => this.plan(due));

    // All new runs in one statement. ON CONFLICT DO NOTHING: an occurrence that already has a
    // run (retried tick, race) is a duplicate, never an error that aborts the batch.
    const rows = plans.flatMap((p) => (p.run ? [p.run] : []));
    const inserted = new Set<string>();
    if (rows.length) {
      await tx.workflowRun.createMany({ data: rows, skipDuplicates: true });
      const found = await tx.workflowRun.findMany({
        where: { id: { in: rows.map((r) => r.id!) } },
        select: { id: true },
      });
      for (const r of found) inserted.add(r.id);
    }

    // All schedule advances in one statement.
    const toIso = (d: Date | null) => (d ? d.toISOString() : null);
    await tx.$executeRaw`
      UPDATE "WorkflowSchedule" AS s
      SET "nextRunAt" = v.next,
          active = v.active,
          "lastOccurrenceAt" = COALESCE(v.occ, s."lastOccurrenceAt"),
          "lastRunId" = COALESCE(v.run, s."lastRunId"),
          "updatedAt" = now()
      FROM unnest(
        ${plans.map((p) => p.due.id)}::text[]::uuid[],
        ${plans.map((p) => toIso(p.update.next))}::text[]::timestamptz[],
        ${plans.map((p) => p.update.active)}::boolean[],
        ${plans.map((p) => toIso(p.update.occurrence))}::text[]::timestamptz[],
        ${plans.map((p) => (p.run && inserted.has(p.run.id!) ? p.run.id! : null))}::text[]::uuid[]
      ) AS v(id, next, active, occ, run)
      WHERE s.id = v.id`;

    return plans.map((p) => {
      if (p.outcome.kind !== 'fired' || !p.run) return p.outcome;
      if (inserted.has(p.run.id!)) return p.outcome;
      this.logger.info(
        {
          scheduleId: p.due.id,
          workflowId: p.due.workflowId,
          workspaceId: p.due.workspaceId,
          scheduledFor: (p.outcome.enqueue as { scheduledFor: string }).scheduledFor,
          workerId: this.workerId,
        },
        'Schedule occurrence already has a run; duplicate suppressed',
      );
      return { kind: 'duplicate', skipped: p.outcome.skipped };
    });
  }

  /** The rules for one claimed schedule, decided in memory (no I/O). */
  private plan(due: DueRow): Plan {
    const ids = { scheduleId: due.id, workflowId: due.workflowId, workspaceId: due.workspaceId };
    const stop = (reason: string): Plan => {
      this.logger.warn({ ...ids, reason, workerId: this.workerId }, 'Schedule deactivated');
      return {
        due,
        outcome: { kind: 'deactivated' },
        update: { next: null, active: false, occurrence: null },
      };
    };

    // FR-23.10: only a published workflow whose active version is this schedule's, in the
    // schedule's own workspace, may run. Anything else stops the schedule.
    if (
      due.workflowStatus !== WorkflowStatus.PUBLISHED ||
      due.activeVersionId !== due.workflowVersionId ||
      due.workflowWorkspaceId !== due.workspaceId
    ) {
      return stop('the workflow is no longer published with this version');
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
      return stop(`the schedule cannot be evaluated: ${(err as Error).message}`);
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
    if (!occurrence.next) {
      this.logger.warn(
        { ...ids, workerId: this.workerId },
        'Schedule deactivated: it never runs again',
      );
    }
    const update = {
      next: occurrence.next,
      active: occurrence.next !== null,
      occurrence: occurrence.fire,
    };

    // http.poll (Part 24): the occurrence is a poll, run by the poll queue; items become runs.
    if (due.kind === ScheduleKind.POLL) {
      return {
        due,
        update,
        outcome: occurrence.fire
          ? { kind: 'poll', skipped, scheduleId: due.id, occurrence: occurrence.fire.toISOString() }
          : { kind: 'skipped', skipped },
      };
    }
    if (!occurrence.fire) return { due, update, outcome: { kind: 'skipped', skipped } };

    const fire = occurrence.fire;
    const runId = randomUUID();
    const correlationId = randomUUID();
    const triggerInput: ScheduleTriggerInput = {
      triggerType: 'SCHEDULE',
      scheduledFor: fire.toISOString(),
      triggeredAt: due.dbNow.toISOString(),
      timezone: due.timezone,
      scheduleId: due.id,
    };
    return {
      due,
      update,
      run: {
        id: runId,
        workspaceId: due.workspaceId,
        workflowId: due.workflowId,
        workflowVersionId: due.workflowVersionId,
        triggerSource: TriggerSource.SCHEDULE,
        idempotencyKey: occurrenceKey(due.id, fire),
        triggerInput: triggerInput as unknown as Prisma.InputJsonObject,
        correlationId,
      },
      outcome: {
        kind: 'fired',
        skipped,
        enqueue: {
          ...ids,
          runId,
          correlationId,
          scheduledFor: fire.toISOString(),
          lagMs: due.dbNow.getTime() - fire.getTime(),
        },
      },
    };
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
