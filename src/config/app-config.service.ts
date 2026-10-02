import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from './env.schema';

/** Typed wrapper around ConfigService so callers never deal with raw strings. */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  get swaggerEnabled(): boolean {
    return this.get('SWAGGER_ENABLED') ?? !this.isProduction;
  }

  get throttleEnabled(): boolean {
    return this.get('THROTTLE_ENABLED') ?? true;
  }

  get corsOrigins(): string[] {
    return this.get('CORS_ORIGINS')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }

  get queue() {
    return {
      prefix: this.get('QUEUE_PREFIX'),
      attempts: this.get('QUEUE_JOB_ATTEMPTS'),
      backoffMs: this.get('QUEUE_BACKOFF_MS'),
      concurrency: this.get('WORKER_CONCURRENCY'),
      nodeTimeoutMs: this.get('NODE_TIMEOUT_MS'),
      sweeperStaleAfterMs: this.get('SWEEPER_STALE_AFTER_MS'),
      sweeperIntervalMs: this.get('SWEEPER_INTERVAL_MS'),
    };
  }

  get ai() {
    return {
      provider: this.get('AI_PROVIDER'),
      apiKey: this.get('AI_API_KEY'),
      apiUrl: this.get('AI_API_URL'),
      model: this.get('AI_MODEL'),
      timeoutMs: this.get('AI_TIMEOUT_MS'),
      maxInputChars: this.get('AI_MAX_INPUT_CHARS'),
      maxOutputTokens: this.get('AI_MAX_OUTPUT_TOKENS'),
    };
  }

  get redis() {
    return {
      host: this.get('REDIS_HOST'),
      port: this.get('REDIS_PORT'),
      password: this.get('REDIS_PASSWORD') || undefined,
    };
  }
}
