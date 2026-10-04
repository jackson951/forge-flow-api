import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ExecutePollJobData, JOBS, QUEUES } from './queue.constants';

/**
 * Enqueues http.poll occurrences (Part 24). The job id is the occurrence, so enqueueing the
 * same occurrence twice is a no-op. A lost enqueue only skips one poll: polling is state-based,
 * the next occurrence picks up whatever is new.
 */
@Injectable()
export class PollQueue {
  constructor(@InjectQueue(QUEUES.HTTP_POLLS) readonly queue: Queue<ExecutePollJobData>) {}

  async enqueue(data: ExecutePollJobData): Promise<void> {
    await this.queue.add(JOBS.EXECUTE_POLL, data, {
      jobId: `poll-${data.scheduleId}-${Date.parse(data.occurrence)}`,
      attempts: 1,
      removeOnComplete: { age: 24 * 3600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  }
}
