import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DelayedError, Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import {
  ExecutePollJobData,
  ExecuteRunJobData,
  JOBS,
  QUEUES,
} from '../infrastructure/queue/queue.constants';
import { runBackoffStrategy } from '../infrastructure/queue/retry-backoff';
import { RunQueue } from '../infrastructure/queue/run-queue.service';
import { HttpPollRunner } from './http-poll-runner';
import { PrismaRunStore } from './prisma-run-store';
import { RetentionService } from './retention.service';
import { ScheduleEvaluator } from './schedule-evaluator';
import { RunPostponedError, RunWorkerService } from './run-worker.service';

/**
 * Consumes `workflow-runs`. Registered only in the worker process.
 * Lock renewal keeps long steps owned; a job whose worker dies stalls and is redelivered
 * once (maxStalledCount 1), then resumes per the engine's side-effect rules.
 */
/**
 * How long a job's lock lives without renewal; a job whose worker stops renewing it (crash)
 * is redelivered after about this long. Read when the processor is defined (BullMQ fixes lock
 * settings at construction); validated with the rest of the environment.
 */
const LOCK_DURATION_MS = Number(process.env.WORKER_LOCK_DURATION_MS) || 30_000;

@Processor(QUEUES.WORKFLOW_RUNS, {
  maxStalledCount: 1,
  lockDuration: LOCK_DURATION_MS,
  stalledInterval: LOCK_DURATION_MS,
  settings: { backoffStrategy: runBackoffStrategy },
})
export class WorkflowRunProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly runs: RunWorkerService,
    private readonly config: AppConfigService,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    this.worker.concurrency = this.config.queue.concurrency;
  }

  async process(job: Job<ExecuteRunJobData>, token?: string): Promise<void> {
    try {
      await this.runs.process(job.data.runId, {
        jobId: String(job.id),
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? 1,
      });
    } catch (err) {
      if (!(err instanceof RunPostponedError)) throw err;
      // Delayed, not failed: BullMQ does not count it as an attempt (Part 21, FR-21.3).
      await job.moveToDelayed(Date.now() + err.delayMs, token);
      throw new DelayedError();
    }
  }
}

/** Re-enqueues runs stuck in QUEUED (their enqueue was lost). Enqueueing is idempotent. */
@Injectable()
export class RunSweeper {
  constructor(
    private readonly store: PrismaRunStore,
    private readonly queue: RunQueue,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RunSweeper.name);
  }

  async sweep(limit = 100): Promise<number> {
    const olderThan = new Date(Date.now() - this.config.queue.sweeperStaleAfterMs);
    const stale = await this.store.findStaleQueuedRuns(olderThan, limit);
    for (const run of stale) await this.queue.enqueue(run.id, { reason: 'sweeper' });
    if (stale.length) this.logger.info({ count: stale.length }, 'Re-enqueued stale QUEUED runs');
    return stale.length;
  }
}

@Processor(QUEUES.MAINTENANCE)
export class MaintenanceProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly sweeper: RunSweeper,
    private readonly retention: RetentionService,
    private readonly schedules: ScheduleEvaluator,
    private readonly config: AppConfigService,
    @InjectQueue(QUEUES.MAINTENANCE) private readonly maintenance: Queue,
  ) {
    super();
  }

  /** One schedule shared by all workers (upsert is idempotent across processes). */
  async onApplicationBootstrap(): Promise<void> {
    await this.maintenance.upsertJobScheduler(
      JOBS.SWEEP_QUEUED_RUNS,
      { every: this.config.queue.sweeperIntervalMs },
      { name: JOBS.SWEEP_QUEUED_RUNS, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
    // Part 23: due schedule occurrences → QUEUED runs.
    await this.maintenance.upsertJobScheduler(
      JOBS.EVALUATE_SCHEDULES,
      { every: this.config.schedule.tickIntervalMs },
      { name: JOBS.EVALUATE_SCHEDULES, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
    const retention = this.config.retention;
    if (retention.enabled) {
      await this.maintenance.upsertJobScheduler(
        JOBS.APPLY_RETENTION,
        { every: retention.intervalMs },
        { name: JOBS.APPLY_RETENTION, opts: { removeOnComplete: true, removeOnFail: 100 } },
      );
    } else {
      await this.maintenance.removeJobScheduler(JOBS.APPLY_RETENTION);
    }
  }

  async process(job: Job): Promise<void> {
    if (job.name === JOBS.SWEEP_QUEUED_RUNS) await this.sweeper.sweep();
    if (job.name === JOBS.EVALUATE_SCHEDULES) await this.schedules.tick();
    if (job.name === JOBS.APPLY_RETENTION && this.config.retention.enabled) {
      await this.retention.run();
    }
  }
}

/**
 * http.poll occurrences (Part 24). A separate queue, so slow third-party APIs never hold up
 * the sweeper, retention or schedule ticks. A poll never fails its job: failures are recorded
 * on the poll state and the next occurrence tries again.
 */
@Processor(QUEUES.HTTP_POLLS)
export class HttpPollProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly runner: HttpPollRunner,
    private readonly config: AppConfigService,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    this.worker.concurrency = this.config.http.pollConcurrency;
  }

  async process(job: Job<ExecutePollJobData>): Promise<void> {
    if (job.name === JOBS.EXECUTE_POLL) await this.runner.run(job.data);
  }
}
