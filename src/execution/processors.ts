import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { ExecuteRunJobData, JOBS, QUEUES } from '../infrastructure/queue/queue.constants';
import { runBackoffStrategy } from '../infrastructure/queue/retry-backoff';
import { RunQueue } from '../infrastructure/queue/run-queue.service';
import { PrismaRunStore } from './prisma-run-store';
import { RunWorkerService } from './run-worker.service';

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

  async process(job: Job<ExecuteRunJobData>): Promise<void> {
    await this.runs.process(job.data.runId, {
      jobId: String(job.id),
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 1,
    });
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
  }

  async process(job: Job): Promise<void> {
    if (job.name === JOBS.SWEEP_QUEUED_RUNS) await this.sweeper.sweep();
  }
}
