import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { IntegrationProviderKey } from '@prisma/client';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { JOBS, QUEUES } from '../../infrastructure/queue/queue.constants';

/**
 * After a publish / archive / unarchive / delete, asks the worker to bring provider
 * registrations (Jira webhooks, Part 25) in line with the workspace's published triggers.
 * Runs after the commit, so publishing never waits for a provider; the periodic renewal job
 * reconciles anything a lost request missed.
 */
@Injectable()
export class ProviderSyncRequester {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.MAINTENANCE) private readonly maintenance: Queue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ProviderSyncRequester.name);
  }

  async request(workspaceId: string): Promise<void> {
    try {
      const subscribing = await this.prisma.integrationConnection.count({
        where: { workspaceId, provider: IntegrationProviderKey.JIRA },
      });
      if (!subscribing) return;
      await this.maintenance.add(
        JOBS.SYNC_SUBSCRIPTIONS,
        { workspaceId },
        { removeOnComplete: true, removeOnFail: 100 },
      );
    } catch (err) {
      this.logger.warn(
        { workspaceId, error: (err as Error).message },
        'Could not request a provider sync; the periodic job will catch up',
      );
    }
  }
}
