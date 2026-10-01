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

    it('rejects wildcard CORS origins', () => {
      expect(() => validateEnv({ ...prod, CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS/);
    });
  });
});
