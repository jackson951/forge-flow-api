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

    /** "k1:<base64 32 bytes>[,k2:…]" — keys for credentials at rest (Part 17). */
    ENCRYPTION_KEYS: z.string().optional(),
    ENCRYPTION_ACTIVE_KEY_ID: z.string().optional(),

    /** Where OAuth callbacks send the browser back to (frontend). */
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),

    // GitHub App (Part 10). Private key: base64 of the PEM file (or the PEM itself).
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_APP_SLUG: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_API_URL: z.string().url().default('https://api.github.com'),
    GITHUB_WEB_URL: z.string().url().default('https://github.com'),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    GITHUB_WEBHOOK_SECRET: z.string().optional(),
    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_TENANT_ID: z.string().default('common'),
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
    AI_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
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
