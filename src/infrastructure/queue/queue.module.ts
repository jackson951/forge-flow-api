import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { QUEUES } from './queue.constants';
import { QueueBackpressure } from './queue-backpressure.service';
import { PollQueue } from './poll-queue.service';
import { RunQueue } from './run-queue.service';

/**
 * BullMQ connection and queues, shared by API and worker. Processors are registered only in
 * the worker (ExecutionModule); importing this module never consumes jobs.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [AppConfigService],
      // BullMQ opens its own connections (workers need maxRetriesPerRequest: null).
      useFactory: (config: AppConfigService) => ({
        connection: config.redis,
        prefix: config.queue.prefix,
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUES.WORKFLOW_RUNS },
      { name: QUEUES.MAINTENANCE },
      { name: QUEUES.HTTP_POLLS },
    ),
  ],
  providers: [RunQueue, PollQueue, QueueBackpressure],
  exports: [BullModule, RunQueue, PollQueue, QueueBackpressure],
})
export class QueueModule {}
