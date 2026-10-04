import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { databaseUrlWithPool, Env } from './env.schema';

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
      providerConcurrency:
        this.get('PROVIDER_CONCURRENCY') ?? Math.ceil(this.get('WORKER_CONCURRENCY') / 2),
      backpressureThreshold: this.get('QUEUE_BACKPRESSURE_THRESHOLD'),
    };
  }

  get databaseUrl(): string {
    return databaseUrlWithPool(this.get('DATABASE_URL'), this.get('DATABASE_CONNECTION_LIMIT'));
  }

  get http() {
    const list = (v: string) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return {
      enabled: this.get('HTTP_ACTION_ENABLED') ?? true,
      maxResponseBytes: this.get('HTTP_ACTION_MAX_RESPONSE_BYTES'),
      maxStoredBodyBytes: this.get('HTTP_ACTION_MAX_STORED_BODY_BYTES'),
      maxPollsPerWorkspace: this.get('HTTP_POLL_MAX_PER_WORKSPACE'),
      pollConcurrency: this.get('HTTP_POLL_CONCURRENCY'),
      policy: {
        allowPlainHttp: this.get('HTTP_ACTION_ALLOW_PLAIN_HTTP') ?? false,
        allowPrivateNetworks: this.get('HTTP_ACTION_ALLOW_PRIVATE_NETWORKS') ?? false,
        deniedPorts: list(this.get('HTTP_ACTION_DENIED_PORTS')).map(Number),
        deniedHosts: list(this.get('HTTP_ACTION_DENIED_HOSTS')),
      },
    };
  }

  get gmail() {
    return {
      clientId: this.get('GOOGLE_CLIENT_ID'),
      clientSecret: this.get('GOOGLE_CLIENT_SECRET'),
      authUrl: this.get('GOOGLE_AUTH_URL'),
      tokenUrl: this.get('GOOGLE_TOKEN_URL'),
      revokeUrl: this.get('GOOGLE_REVOKE_URL'),
      userinfoUrl: this.get('GOOGLE_USERINFO_URL'),
      jwksUrl: this.get('GOOGLE_JWKS_URL'),
      apiUrl: this.get('GMAIL_API_URL').replace(/\/+$/, ''),
      topic: this.get('GMAIL_PUBSUB_TOPIC'),
      pushAudience: this.get('GMAIL_PUSH_AUDIENCE'),
      pushServiceAccount: this.get('GMAIL_PUSH_SERVICE_ACCOUNT'),
      renewWithinMs: this.get('GMAIL_WATCH_RENEW_WITHIN_HOURS') * 3_600_000,
      dailySendCap: this.get('GMAIL_DAILY_SEND_CAP_PER_WORKSPACE'),
      maxBodyChars: this.get('GMAIL_MAX_BODY_CHARS'),
    };
  }

  get jira() {
    return {
      clientId: this.get('JIRA_CLIENT_ID'),
      clientSecret: this.get('JIRA_CLIENT_SECRET'),
      authUrl: this.get('JIRA_AUTH_URL').replace(/\/+$/, ''),
      apiUrl: this.get('JIRA_API_URL').replace(/\/+$/, ''),
      renewWithinMs: this.get('JIRA_WEBHOOK_RENEW_WITHIN_DAYS') * 86_400_000,
      subscriptionIntervalMs: this.get('SUBSCRIPTION_RENEW_INTERVAL_MS'),
    };
  }

  get hooks() {
    return {
      maxBodyBytes: this.get('WEBHOOK_HOOK_MAX_BODY_BYTES'),
      perIpPerMinute: this.get('WEBHOOK_HOOK_PER_IP_PER_MINUTE'),
      dailyCapPerWorkspace: this.get('WEBHOOK_HOOK_DAILY_CAP_PER_WORKSPACE'),
      rotationGraceHours: this.get('WEBHOOK_HOOK_ROTATION_GRACE_HOURS'),
      publicApiUrl: this.get('PUBLIC_API_URL'),
    };
  }

  get schedule() {
    return {
      tickIntervalMs: this.get('SCHEDULE_TICK_INTERVAL_MS'),
      misfireGraceMs: this.get('SCHEDULE_MISFIRE_GRACE_MS'),
      minIntervalMinutes: this.get('SCHEDULE_MIN_INTERVAL_MINUTES'),
      batchSize: this.get('SCHEDULE_BATCH_SIZE'),
    };
  }

  get retention() {
    const days = (n: number) => n * 24 * 3_600_000;
    return {
      enabled: this.get('RETENTION_ENABLED') ?? true,
      webhookDeliveryMs: days(this.get('RETENTION_WEBHOOK_DELIVERY_DAYS')),
      stepPayloadMs: days(this.get('RETENTION_STEP_PAYLOAD_DAYS')),
      runMs: days(this.get('RETENTION_RUN_DAYS')),
      batchSize: this.get('RETENTION_BATCH_SIZE'),
      maxBatches: this.get('RETENTION_MAX_BATCHES'),
      intervalMs: this.get('RETENTION_INTERVAL_MS'),
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
