import { z } from 'zod';
import { parseKeyring } from '../infrastructure/crypto/envelope';

/** Treats an empty variable (`KEY=` in .env) as unset. */
const emptyAsUnset = (v: unknown) => (v === '' ? undefined : v);

const booleanString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/** Durations such as "900s", "15m", "12h", "7d". */
const duration = z.string().regex(/^\d+[smhd]$/, 'must look like 900s, 15m, 12h or 7d');

/** Pool size when neither DATABASE_CONNECTION_LIMIT nor `connection_limit` is set. */
export const DEFAULT_CONNECTION_LIMIT = 10;

/** Effective Prisma pool size: the variable, else the URL parameter, else the default. */
export function connectionLimit(databaseUrl: string, explicit?: number): number {
  if (explicit) return explicit;
  const fromUrl = Number(new URL(databaseUrl).searchParams.get('connection_limit'));
  return Number.isInteger(fromUrl) && fromUrl > 0 ? fromUrl : DEFAULT_CONNECTION_LIMIT;
}

/** DATABASE_URL with the effective `connection_limit` set. */
export function databaseUrlWithPool(databaseUrl: string, explicit?: number): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('connection_limit', String(connectionLimit(databaseUrl, explicit)));
  return url.toString();
}

/** Prefix used by `.env.example` placeholders; never acceptable in production. */
const PLACEHOLDER_PREFIX = 'change-me';

/**
 * Environment contract. The app refuses to boot if this fails,
 * so misconfiguration surfaces at startup rather than at runtime.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    API_PREFIX: z.string().default('api'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    /** Number of trusted reverse-proxy hops in front of the API (0 = none). */
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
    /** Defaults to enabled outside production. */
    SWAGGER_ENABLED: booleanString,
    /** Rate limiting; may only be disabled outside production (used by tests). */
    THROTTLE_ENABLED: booleanString,

    DATABASE_URL: z.string().url(),
    /**
     * Prisma pool size per process (Part 21). Overrides `connection_limit` in DATABASE_URL;
     * with neither set the pool is DEFAULT_CONNECTION_LIMIT. Sizing: docs/backend/21-*.
     */
    DATABASE_CONNECTION_LIMIT: z.preprocess(
      emptyAsUnset,
      z.coerce.number().int().min(1).max(200).optional(),
    ),

    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: z.coerce.number().int().positive().default(6379),
    REDIS_PASSWORD: z.string().optional(),

    /** BullMQ key prefix; tests use a unique one so they never share queues with dev. */
    QUEUE_PREFIX: z
      .string()
      .regex(/^[A-Za-z0-9:_-]{1,64}$/)
      .default('flowforge'),
    QUEUE_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    QUEUE_BACKOFF_MS: z.coerce.number().int().min(1).default(2_000),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
    NODE_TIMEOUT_MS: z.coerce.number().int().min(100).default(30_000),
    /** Worker liveness file for container health checks (unset = disabled). */
    WORKER_HEARTBEAT_FILE: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
    /** BullMQ job lock; a crashed worker's job is redelivered after about this long. */
    WORKER_LOCK_DURATION_MS: z.coerce.number().int().min(1_000).default(30_000),
    /** QUEUED runs older than this are re-enqueued by the sweeper (lost-enqueue recovery). */
    SWEEPER_STALE_AFTER_MS: z.coerce.number().int().min(1_000).default(60_000),
    SWEEPER_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
    /**
     * Steps of one provider (github, slack, microsoft, ai) running at once per worker
     * process. Unset: half of WORKER_CONCURRENCY (rounded up), so a slow provider never
     * occupies every slot.
     */
    PROVIDER_CONCURRENCY: z.preprocess(
      emptyAsUnset,
      z.coerce.number().int().min(1).max(100).optional(),
    ),
    /** Waiting jobs above which manual runs get 429 (webhooks are still accepted). 0 = off. */
    QUEUE_BACKPRESSURE_THRESHOLD: z.coerce.number().int().min(0).default(5_000),

    /** Retention (Part 21): a maintenance job deletes/trims expired history in batches. */
    RETENTION_ENABLED: booleanString,
    RETENTION_WEBHOOK_DELIVERY_DAYS: z.coerce.number().int().min(1).default(30),
    RETENTION_STEP_PAYLOAD_DAYS: z.coerce.number().int().min(1).default(30),
    RETENTION_RUN_DAYS: z.coerce.number().int().min(1).default(90),
    RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(1_000),
    /** Upper bound of batches per category per tick, so one tick never runs for long. */
    RETENTION_MAX_BATCHES: z.coerce.number().int().min(1).max(1_000).default(50),
    RETENTION_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),

    /** Schedule trigger (Part 23): a maintenance job turns due occurrences into runs. */
    SCHEDULE_TICK_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
    /** A missed occurrence older than this is skipped instead of run late (FR-23.7). */
    SCHEDULE_MISFIRE_GRACE_MS: z.coerce.number().int().min(60_000).default(3_600_000),
    /** Smallest allowed gap between occurrences of one schedule, in minutes (FR-23.3). */
    SCHEDULE_MIN_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1_440).default(5),
    /** Due schedules handled per tick per worker (each in its own short transaction). */
    SCHEDULE_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(200),

    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_TTL: duration.default('15m'),
    JWT_REFRESH_SECRET: z.string().min(32),
    JWT_REFRESH_TTL: duration.default('7d'),
    JWT_ISSUER: z.string().default('flowforge'),
    JWT_AUDIENCE: z.string().default('flowforge-api'),

    /** "k1:<base64 32 bytes>[,k2:…]" — keys for credentials at rest (Part 17). */
    ENCRYPTION_KEYS: z.string().optional(),
    ENCRYPTION_ACTIVE_KEY_ID: z.string().optional(),

    /** Where OAuth callbacks send the browser back to (frontend). */
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),

    // GitHub App (Part 10). Private key: base64 of the PEM file (or the PEM itself).
    GITHUB_APP_ID: z.string().optional(),
    // Empty (as in .env.example) means not configured.
    GITHUB_APP_SLUG: z.preprocess(
      emptyAsUnset,
      z
        .string()
        .regex(/^[a-z0-9-]+$/)
        .optional(),
    ),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_API_URL: z.string().url().default('https://api.github.com'),
    GITHUB_WEB_URL: z.string().url().default('https://github.com'),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    GITHUB_WEBHOOK_SECRET: z.string().optional(),
    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    /** common | organizations | consumers | a tenant id or domain (single-tenant). */
    MICROSOFT_TENANT_ID: z
      .string()
      .regex(/^[A-Za-z0-9.-]{1,100}$/)
      .default('common'),
    MICROSOFT_LOGIN_URL: z.string().url().default('https://login.microsoftonline.com'),
    MICROSOFT_GRAPH_URL: z.string().url().default('https://graph.microsoft.com/v1.0'),
    SLACK_CLIENT_ID: z.string().optional(),
    SLACK_CLIENT_SECRET: z.string().optional(),
    SLACK_SIGNING_SECRET: z.string().optional(),
    SLACK_API_URL: z.string().url().default('https://slack.com/api'),
    SLACK_OAUTH_URL: z.string().url().default('https://slack.com/oauth/v2/authorize'),
    OAUTH_REDIRECT_BASE_URL: z.string().url().optional(),

    /** Enables the non-production `test` webhook provider (Part 09). Ignored in production. */
    WEBHOOK_TEST_SECRET: z.string().min(16).optional(),

    /**
     * AI steps (Part 12). Unset: ai.* nodes cannot be published. "fake" is a deterministic
     * provider for tests and local demos (not allowed in production).
     */
    AI_PROVIDER: z.preprocess(emptyAsUnset, z.enum(['anthropic', 'fake']).optional()),
    AI_API_KEY: z.string().optional(),
    AI_API_URL: z.string().url().default('https://api.anthropic.com'),
    AI_MODEL: z.preprocess(emptyAsUnset, z.string().default('claude-haiku-4-5-20251001')),
    /** Outbound calls are capped at 30 s (Part 18). */
    AI_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(20000),
    AI_MAX_INPUT_CHARS: z.coerce.number().int().min(1_000).max(200_000).default(20_000),
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(8_192).default(1_024),
  })
  .superRefine((env, ctx) => {
    if (env.ENCRYPTION_KEYS) {
      try {
        const keyring = parseKeyring(env.ENCRYPTION_KEYS);
        if (!env.ENCRYPTION_ACTIVE_KEY_ID || !keyring.has(env.ENCRYPTION_ACTIVE_KEY_ID)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['ENCRYPTION_ACTIVE_KEY_ID'],
            message: 'must name one of the ENCRYPTION_KEYS ids',
          });
        }
      } catch (err) {
        // Only the reason is reported, never key material.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ENCRYPTION_KEYS'],
          message: (err as Error).message,
        });
      }
    }

    // A due occurrence waits up to one tick; a shorter grace would skip on-time occurrences.
    if (env.SCHEDULE_MISFIRE_GRACE_MS < 2 * env.SCHEDULE_TICK_INTERVAL_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SCHEDULE_MISFIRE_GRACE_MS'],
        message: 'must be at least twice SCHEDULE_TICK_INTERVAL_MS',
      });
    }

    if (env.RETENTION_STEP_PAYLOAD_DAYS > env.RETENTION_RUN_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RETENTION_STEP_PAYLOAD_DAYS'],
        message: 'must not exceed RETENTION_RUN_DAYS',
      });
    }

    // A worker needs one connection per concurrent run plus a little for the sweeper and
    // retention jobs; fewer means runs queue for connections and time out (P2024).
    const pool = connectionLimit(env.DATABASE_URL, env.DATABASE_CONNECTION_LIMIT);
    if (pool < env.WORKER_CONCURRENCY + 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_CONNECTION_LIMIT'],
        message: `pool of ${pool} is too small for WORKER_CONCURRENCY ${env.WORKER_CONCURRENCY}; use at least ${env.WORKER_CONCURRENCY + 2}`,
      });
    }

    if (env.AI_PROVIDER === 'anthropic' && !env.AI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_API_KEY'],
        message: 'required when AI_PROVIDER is "anthropic"',
      });
    }

    if (env.NODE_ENV !== 'production') return;

    if (env.AI_PROVIDER === 'fake') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_PROVIDER'],
        message: 'the fake AI provider is not allowed in production',
      });
    }

    if ((env.SLACK_CLIENT_ID || env.MICROSOFT_CLIENT_ID) && !env.ENCRYPTION_KEYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENCRYPTION_KEYS'],
        message: 'required in production when token-storing integrations are configured',
      });
    }

    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      if (env[key].startsWith(PLACEHOLDER_PREFIX)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'placeholder secret is not allowed in production',
        });
      }
    }
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'must differ from JWT_ACCESS_SECRET',
      });
    }
    if (env.THROTTLE_ENABLED === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['THROTTLE_ENABLED'],
        message: 'rate limiting cannot be disabled in production',
      });
    }
    if (env.CORS_ORIGINS.split(',').some((o) => o.trim() === '*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'wildcard origin is not allowed in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
