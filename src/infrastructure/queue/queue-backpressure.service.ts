import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';
import { RunQueue } from './run-queue.service';

/** How long a waiting-count reading is reused (one Redis call per second per process). */
const SAMPLE_TTL_MS = 1_000;
/** At most one alert log per process in this window. */
const ALERT_INTERVAL_MS = 30_000;
/** Suggested wait for clients that receive 429. */
export const BACKPRESSURE_RETRY_AFTER_S = 30;

/** 429 with a Retry-After header (set by AllExceptionsFilter). */
export class QueueBusyException extends HttpException {
  readonly retryAfterSeconds = BACKPRESSURE_RETRY_AFTER_S;

  constructor() {
    super(
      {
        message: 'Too many runs are waiting to be processed; try again shortly',
        details: { code: 'QUEUE_BACKPRESSURE', retryAfterSeconds: BACKPRESSURE_RETRY_AFTER_S },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Backpressure (Part 21, FR-21.11). When more than QUEUE_BACKPRESSURE_THRESHOLD jobs are
 * waiting, manual runs are refused with 429 — a person can try again later — while webhook
 * deliveries are still accepted: the provider will not resend them, and each run is stored
 * in the database before it is enqueued, so the database is the buffer.
 *
 * Fails open: if Redis cannot be asked, nothing is refused (enqueueing then fails anyway
 * and the sweeper recovers the runs).
 */
@Injectable()
export class QueueBackpressure {
  private sample?: { waiting: number; at: number };
  private lastAlertAt = 0;

  constructor(
    private readonly queue: RunQueue,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(QueueBackpressure.name);
  }

  /** For manual triggers: throws QueueBusyException when the queue is over the threshold. */
  async assertAcceptingManualRuns(): Promise<void> {
    if (await this.isOverloaded('manual')) throw new QueueBusyException();
  }

  /** For webhook intake and scheduled runs (Part 23): never refuses, only raises the alert. */
  async observe(source: 'webhook' | 'schedule' = 'webhook'): Promise<void> {
    await this.isOverloaded(source);
  }

  private async isOverloaded(source: 'manual' | 'webhook' | 'schedule'): Promise<boolean> {
    const threshold = this.config.queue.backpressureThreshold;
    if (threshold === 0) return false;
    const waiting = await this.waiting();
    if (waiting === undefined || waiting <= threshold) return false;
    const now = Date.now();
    if (now - this.lastAlertAt >= ALERT_INTERVAL_MS) {
      this.lastAlertAt = now;
      this.logger.warn(
        { alert: 'queue_backpressure', waiting, threshold, source },
        'Run queue backlog above threshold: manual runs are refused with 429 until it drains',
      );
    }
    return true;
  }

  private async waiting(): Promise<number | undefined> {
    const now = Date.now();
    if (this.sample && now - this.sample.at < SAMPLE_TTL_MS) return this.sample.waiting;
    let timer: NodeJS.Timeout | undefined;
    try {
      // A Redis that hangs must not hold up the request.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('queue depth check timed out')), 500);
      });
      const waiting = await Promise.race([this.queue.queue.getWaitingCount(), timeout]);
      this.sample = { waiting, at: now };
      return waiting;
    } catch (err) {
      this.sample = undefined;
      this.logger.warn({ error: (err as Error).message }, 'Could not read queue depth');
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
