import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { rm, writeFile } from 'node:fs/promises';
import { AppConfigService } from '../config/app-config.service';
import { WorkflowRunProcessor } from './processors';

const INTERVAL_MS = 15_000;

/**
 * Liveness signal for container health checks (Part 20): while the run consumer is running,
 * the worker rewrites WORKER_HEARTBEAT_FILE every 15 s; the check fails when the file is
 * older than a minute (worker hung or stopped consuming). Disabled when the variable is
 * unset (development, tests).
 */
@Injectable()
export class WorkerHeartbeat implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private readonly file?: string;

  constructor(
    config: AppConfigService,
    private readonly processor: WorkflowRunProcessor,
    private readonly logger: PinoLogger,
  ) {
    this.file = config.get('WORKER_HEARTBEAT_FILE');
    this.logger.setContext(WorkerHeartbeat.name);
  }

  onApplicationBootstrap(): void {
    if (!this.file) return;
    void this.beat();
    this.timer = setInterval(() => void this.beat(), INTERVAL_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.file) await rm(this.file, { force: true }).catch(() => undefined);
  }

  private async beat(): Promise<void> {
    if (!this.processor.worker?.isRunning()) return;
    try {
      await writeFile(this.file!, new Date().toISOString());
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Could not write the heartbeat file');
    }
  }
}
