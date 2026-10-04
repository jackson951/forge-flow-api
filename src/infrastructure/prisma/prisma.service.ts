import { Inject, Injectable, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppConfigService } from '../../config/app-config.service';

/** Extra client options (tests use it to count queries). */
export const PRISMA_CLIENT_OPTIONS = Symbol('PRISMA_CLIENT_OPTIONS');

/**
 * One pool per process, sized by DATABASE_CONNECTION_LIMIT (Part 21, FR-21.4): the URL's
 * `connection_limit` is set explicitly so the pool never depends on the container's CPU count.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  constructor(
    config: AppConfigService,
    @Optional() @Inject(PRISMA_CLIENT_OPTIONS) options: Prisma.PrismaClientOptions = {},
  ) {
    super({ ...options, datasourceUrl: config.databaseUrl });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /**
   * Last shutdown phase (Part 27): BullMQ workers drain in `beforeApplicationShutdown` and still
   * need the database; `onModuleDestroy` would disconnect underneath their in-flight jobs.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
