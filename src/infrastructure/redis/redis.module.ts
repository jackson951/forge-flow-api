import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';

/** Shared ioredis client for request-path use (readiness, later rate limiting / OAuth state). */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

const SHUTDOWN_TIMEOUT_MS = 5_000;

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Redis => {
        const logger = new Logger('Redis');
        const client = new Redis({
          ...config.redis,
          connectionName: 'flowforge-app',
          // Fail fast instead of queueing commands while disconnected:
          // request handlers must not hang on an unavailable Redis.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          connectTimeout: 5_000,
        });
        client.on('error', (err: Error) => logger.warn(`Redis error: ${err.message}`));
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Resolves once the socket is closed, not merely when QUIT is acknowledged. */
  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'end') return;
    const ended = new Promise<boolean>((resolve) => {
      this.redis.once('end', () => resolve(true));
      setTimeout(() => resolve(false), SHUTDOWN_TIMEOUT_MS).unref();
    });
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
    if (!(await ended)) this.redis.disconnect();
  }
}
