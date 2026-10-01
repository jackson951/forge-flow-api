import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/** Durations such as "900s", "15m", "12h", "7d". */
const duration = z.string().regex(/^\d+[smhd]$/, 'must look like 900s, 15m, 12h or 7d');

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
    /** Defaults to enabled outside production. */
    SWAGGER_ENABLED: booleanString,
    /** Rate limiting; may only be disabled outside production (used by tests). */
    THROTTLE_ENABLED: booleanString,

    DATABASE_URL: z.string().url(),

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
    /** QUEUED runs older than this are re-enqueued by the sweeper (lost-enqueue recovery). */
    SWEEPER_STALE_AFTER_MS: z.coerce.number().int().min(1_000).default(60_000),
    SWEEPER_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),

    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_TTL: duration.default('15m'),
    JWT_REFRESH_SECRET: z.string().min(32),
    JWT_REFRESH_TTL: duration.default('7d'),
    JWT_ISSUER: z.string().default('flowforge'),
    JWT_AUDIENCE: z.string().default('flowforge-api'),

    ENCRYPTION_KEY: z.string().optional(),

    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    GITHUB_WEBHOOK_SECRET: z.string().optional(),
    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_TENANT_ID: z.string().default('common'),
    SLACK_CLIENT_ID: z.string().optional(),
    SLACK_CLIENT_SECRET: z.string().optional(),
    SLACK_SIGNING_SECRET: z.string().optional(),
    OAUTH_REDIRECT_BASE_URL: z.string().url().optional(),

    AI_API_KEY: z.string().optional(),
    AI_MODEL: z.string().optional(),
    AI_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

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
