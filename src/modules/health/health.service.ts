import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.module';

export const DEPENDENCY_CHECK_TIMEOUT_MS = 2_000;

export interface DependencyStatus {
  status: 'up' | 'down';
  latencyMs: number;
}

export interface ReadinessReport {
  status: 'ok' | 'error';
  checks: { database: DependencyStatus; redis: DependencyStatus };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Only critical internal dependencies — never external providers. */
  async readiness(): Promise<ReadinessReport> {
    const [database, redis] = await Promise.all([
      this.check('database', () => this.prisma.$queryRaw`SELECT 1`),
      this.check('redis', () => this.pingRedis()),
    ]);
    const status = database.status === 'up' && redis.status === 'up' ? 'ok' : 'error';
    return { status, checks: { database, redis } };
  }

  /**
   * The client fails fast while (re)connecting (offline queue disabled), so wait for the
   * connection — bounded by the check timeout — instead of reporting a probe sent during
   * startup as "down".
   */
  private async pingRedis(): Promise<unknown> {
    if (this.redis.status === 'connecting' || this.redis.status === 'connect') {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.redis.off('ready', done);
          resolve();
        };
        const timer = setTimeout(done, DEPENDENCY_CHECK_TIMEOUT_MS);
        this.redis.once('ready', done);
      });
    }
    return this.redis.ping();
  }

  private async check(name: string, probe: () => Promise<unknown>): Promise<DependencyStatus> {
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        probe(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${DEPENDENCY_CHECK_TIMEOUT_MS}ms`)),
            DEPENDENCY_CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      return { status: 'up', latencyMs: Date.now() - started };
    } catch (err) {
      this.logger.warn(`Readiness check "${name}" failed: ${(err as Error).message}`);
      return { status: 'down', latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }
}
