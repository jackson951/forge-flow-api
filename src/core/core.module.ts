import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { CryptoModule } from '../infrastructure/crypto/crypto.module';
import { LoggerModule } from '../infrastructure/logger/logger.module';
import { PrismaModule } from '../infrastructure/prisma/prisma.module';
import { QueueModule } from '../infrastructure/queue/queue.module';

/** Infrastructure shared by both the API and the worker process. */
@Module({
  imports: [AppConfigModule, LoggerModule, PrismaModule, QueueModule, CryptoModule],
})
export class CoreModule {}
