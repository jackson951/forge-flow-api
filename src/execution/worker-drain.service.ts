import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import {
  HttpPollProcessor,
  MaintenanceProcessor,
  ProviderEventsProcessor,
  WorkflowRunProcessor,
} from './processors';

/**
 * Graceful worker shutdown (Part 27, FR-27.9). Nest runs `onModuleDestroy` hooks first — where
 * Prisma used to disconnect — and only then `onApplicationShutdown`, where @nestjs/bullmq closes
 * the BullMQ workers. In-flight jobs therefore lost the database mid-step and their runs were
 * left RUNNING. This drains every processor in `beforeApplicationShutdown`: no new jobs are
 * taken and active ones finish (BullMQ `close()` waits for them) while Prisma and Redis are
 * still connected; they disconnect afterwards, in `onApplicationShutdown`.
 */
@Injectable()
export class WorkerDrain implements BeforeApplicationShutdown {
  constructor(
    private readonly runs: WorkflowRunProcessor,
    private readonly maintenance: MaintenanceProcessor,
    private readonly polls: HttpPollProcessor,
    private readonly events: ProviderEventsProcessor,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WorkerDrain.name);
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    const started = Date.now();
    await Promise.all(
      [this.runs, this.maintenance, this.polls, this.events].map((p) => p.worker.close()),
    );
    this.logger.info(
      { signal: signal ?? 'app.close', durationMs: Date.now() - started },
      'Worker drained: in-flight jobs finished',
    );
  }
}
