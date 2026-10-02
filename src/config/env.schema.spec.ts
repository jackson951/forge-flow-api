import { validateEnv } from './env.schema';

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
