import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';
import { ExecuteRunJobData, JOBS, QUEUES } from './queue.constants';
import { RUN_BACKOFF_TYPE } from './retry-backoff';

/** Enqueues run executions. `jobId = runId`, so enqueueing the same run twice is a no-op. */
@Injectable()
export class RunQueue {
  constructor(
    @InjectQueue(QUEUES.WORKFLOW_RUNS) readonly queue: Queue<ExecuteRunJobData>,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RunQueue.name);
  }

  /** `context` (correlationId, workspaceId, ...) is only logged, never put on the job. */
  async enqueue(runId: string, context: Record<string, unknown> = {}): Promise<void> {
    const { attempts, backoffMs } = this.config.queue;
    await this.queue.add(
      JOBS.EXECUTE_RUN,
      { runId },
      {
        jobId: runId,
        attempts,
        // Exponential with jitter, or the provider's Retry-After (see retry-backoff.ts).
        backoff: { type: RUN_BACKOFF_TYPE, delay: backoffMs },
        removeOnComplete: { age: 24 * 3600, count: 1_000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    );
    this.logger.info({ ...context, runId, jobId: runId }, 'Run enqueued');
  }
}
