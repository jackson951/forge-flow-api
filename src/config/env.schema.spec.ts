import { connectionLimit, databaseUrlWithPool, validateEnv } from './env.schema';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
};

describe('validateEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = validateEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.API_PREFIX).toBe('api');
    expect(env.SWAGGER_ENABLED).toBeUndefined();
  });

  it('coerces numeric and boolean strings', () => {
    const env = validateEnv({ ...base, PORT: '8080', SWAGGER_ENABLED: 'false' });
    expect(env.PORT).toBe(8080);
    expect(env.SWAGGER_ENABLED).toBe(false);
  });

  it('lists every missing or invalid variable', () => {
    expect(() => validateEnv({ JWT_ACCESS_SECRET: 'short' })).toThrow(
      /DATABASE_URL[\s\S]*JWT_ACCESS_SECRET[\s\S]*JWT_REFRESH_SECRET/,
    );
  });

  it('validates token lifetimes', () => {
    expect(validateEnv({ ...base, JWT_ACCESS_TTL: '10m' }).JWT_ACCESS_TTL).toBe('10m');
    expect(() => validateEnv({ ...base, JWT_ACCESS_TTL: '15 minutes' })).toThrow(/JWT_ACCESS_TTL/);
  });

  it('allows disabling rate limiting outside production', () => {
    expect(validateEnv({ ...base, THROTTLE_ENABLED: 'false' }).THROTTLE_ENABLED).toBe(false);
  });

  describe('AI provider', () => {
    it('is disabled by default and treats empty values as unset', () => {
      const env = validateEnv({ ...base, AI_PROVIDER: '', AI_MODEL: '' });
      expect(env.AI_PROVIDER).toBeUndefined();
      expect(env.AI_MODEL).toBe('claude-haiku-4-5-20251001');
      expect(env.AI_MAX_INPUT_CHARS).toBe(20_000);
    });

    it('requires an API key for the hosted provider', () => {
      expect(() => validateEnv({ ...base, AI_PROVIDER: 'anthropic' })).toThrow(
        /AI_API_KEY: required when AI_PROVIDER is "anthropic"/,
      );
      expect(validateEnv({ ...base, AI_PROVIDER: 'anthropic', AI_API_KEY: 'k' }).AI_PROVIDER).toBe(
        'anthropic',
      );
      expect(() => validateEnv({ ...base, AI_PROVIDER: 'openai' })).toThrow(/AI_PROVIDER/);
    });

    it('allows the fake provider outside production only', () => {
      expect(validateEnv({ ...base, AI_PROVIDER: 'fake' }).AI_PROVIDER).toBe('fake');
      expect(() =>
        validateEnv({
          ...base,
          NODE_ENV: 'production',
          JWT_ACCESS_SECRET: 'p'.repeat(40),
          JWT_REFRESH_SECRET: 'q'.repeat(40),
          CORS_ORIGINS: 'https://app.example.com',
          AI_PROVIDER: 'fake',
        }),
      ).toThrow(/AI_PROVIDER: the fake AI provider is not allowed in production/);
    });
  });

  describe('encryption keys', () => {
    const key = Buffer.alloc(32, 7).toString('base64');

    it('accepts a valid keyring with an existing active key', () => {
      expect(
        validateEnv({ ...base, ENCRYPTION_KEYS: `k1:${key}`, ENCRYPTION_ACTIVE_KEY_ID: 'k1' })
          .ENCRYPTION_KEYS,
      ).toBe(`k1:${key}`);
    });

    it('rejects a short key without echoing it, and an unknown active id', () => {
      const short = Buffer.alloc(8, 1).toString('base64');
      expect(() =>
        validateEnv({ ...base, ENCRYPTION_KEYS: `k1:${short}`, ENCRYPTION_ACTIVE_KEY_ID: 'k1' }),
      ).toThrow(/ENCRYPTION_KEYS: key "k1" must be 32 bytes/);
      try {
        validateEnv({ ...base, ENCRYPTION_KEYS: `k1:${short}` });
      } catch (err) {
        expect((err as Error).message).not.toContain(short);
      }
      expect(() =>
        validateEnv({ ...base, ENCRYPTION_KEYS: `k1:${key}`, ENCRYPTION_ACTIVE_KEY_ID: 'k2' }),
      ).toThrow(/ENCRYPTION_ACTIVE_KEY_ID/);
    });

    it('requires keys in production when Slack or Microsoft is configured', () => {
      const prod = {
        ...base,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://app.example.com',
        SLACK_CLIENT_ID: 'x',
      };
      expect(() => validateEnv(prod)).toThrow(/ENCRYPTION_KEYS: required in production/);
    });
  });

  describe('database pool (Part 21)', () => {
    const url = 'postgresql://u:p@localhost:5432/db?schema=public';

    it('uses the variable, else the URL parameter, else 10', () => {
      expect(connectionLimit(url)).toBe(10);
      expect(connectionLimit(`${url}&connection_limit=7`)).toBe(7);
      expect(connectionLimit(`${url}&connection_limit=7`, 20)).toBe(20);
      expect(connectionLimit(`${url}&connection_limit=abc`)).toBe(10);
    });

    it('always sets connection_limit on the URL, keeping other parameters', () => {
      const out = new URL(databaseUrlWithPool(`${url}&connection_limit=3`, 12));
      expect(out.searchParams.get('connection_limit')).toBe('12');
      expect(out.searchParams.get('schema')).toBe('public');
      expect(new URL(databaseUrlWithPool(url)).searchParams.get('connection_limit')).toBe('10');
    });

    it('refuses a pool too small for the worker concurrency', () => {
      expect(() => validateEnv({ ...base, WORKER_CONCURRENCY: '20' })).toThrow(
        /DATABASE_CONNECTION_LIMIT: pool of 10 is too small for WORKER_CONCURRENCY 20; use at least 22/,
      );
      expect(
        validateEnv({ ...base, WORKER_CONCURRENCY: '20', DATABASE_CONNECTION_LIMIT: '22' }),
      ).toMatchObject({ DATABASE_CONNECTION_LIMIT: 22 });
      expect(() => validateEnv({ ...base, DATABASE_URL: `${url}&connection_limit=5` })).toThrow(
        /pool of 5/,
      );
      expect(
        validateEnv({ ...base, DATABASE_CONNECTION_LIMIT: '' }).DATABASE_CONNECTION_LIMIT,
      ).toBeUndefined();
    });
  });

  describe('retention (Part 21)', () => {
    it('defaults to 30 / 30 / 90 days', () => {
      expect(validateEnv(base)).toMatchObject({
        RETENTION_WEBHOOK_DELIVERY_DAYS: 30,
        RETENTION_STEP_PAYLOAD_DAYS: 30,
        RETENTION_RUN_DAYS: 90,
        QUEUE_BACKPRESSURE_THRESHOLD: 5_000,
      });
    });

    it('rejects trimming payloads later than runs are deleted', () => {
      expect(() =>
        validateEnv({ ...base, RETENTION_STEP_PAYLOAD_DAYS: '100', RETENTION_RUN_DAYS: '90' }),
      ).toThrow(/RETENTION_STEP_PAYLOAD_DAYS: must not exceed RETENTION_RUN_DAYS/);
    });
  });

  it('rejects an invalid enum value', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  describe('in production', () => {
    const prod = { ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com' };

    it('accepts real secrets', () => {
      expect(validateEnv(prod).NODE_ENV).toBe('production');
    });

    it('rejects placeholder secrets', () => {
      expect(() =>
        validateEnv({ ...prod, JWT_ACCESS_SECRET: 'change-me-access-secret-min-32-chars-long' }),
      ).toThrow(/JWT_ACCESS_SECRET: placeholder secret/);
    });

    it('rejects identical access and refresh secrets', () => {
      expect(() => validateEnv({ ...prod, JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET })).toThrow(
        /JWT_REFRESH_SECRET: must differ/,
      );
    });

    it('refuses to disable rate limiting', () => {
      expect(() => validateEnv({ ...prod, THROTTLE_ENABLED: 'false' })).toThrow(/THROTTLE_ENABLED/);
    });

    it('rejects wildcard CORS origins', () => {
      expect(() => validateEnv({ ...prod, CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS/);
    });
  });
});

describe('.env.example (Part 22: setup from a clean clone)', () => {
  it('passes validation exactly as copied by the setup guide', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parseEnv } = require('node:util') as { parseEnv(s: string): Record<string, string> };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const example = parseEnv(readFileSync(`${__dirname}/../../.env.example`, 'utf8'));
    expect(() => validateEnv(example)).not.toThrow();
  });
});
