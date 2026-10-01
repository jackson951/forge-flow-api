import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AppConfigService } from '../../config/app-config.service';
import { ExecuteRunJobData, JOBS, QUEUES } from './queue.constants';

/** Enqueues run executions. `jobId = runId`, so enqueueing the same run twice is a no-op. */
@Injectable()
export class RunQueue {
  constructor(
    @InjectQueue(QUEUES.WORKFLOW_RUNS) readonly queue: Queue<ExecuteRunJobData>,
    private readonly config: AppConfigService,
  ) {}

  async enqueue(runId: string): Promise<void> {
    const { attempts, backoffMs } = this.config.queue;
    await this.queue.add(
      JOBS.EXECUTE_RUN,
      { runId },
      {
        jobId: runId,
        attempts,
        backoff: { type: 'exponential', delay: backoffMs, jitter: 0.3 },
        removeOnComplete: { age: 24 * 3600, count: 1_000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    );
  }
}
