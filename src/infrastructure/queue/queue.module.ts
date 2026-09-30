import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { QUEUES } from './queue.constants';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        connection: config.redis,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 1_000 },
          removeOnFail: { count: 5_000 },
        },
      }),
    }),
    BullModule.registerQueue({ name: QUEUES.WORKFLOW_RUNS }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
