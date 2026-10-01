import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service';
import { Env } from '../../config/env.schema';
import { TokenService } from './token.service';

const env: Partial<Env> = {
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'r'.repeat(32),
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '7d',
  JWT_ISSUER: 'flowforge',
  JWT_AUDIENCE: 'flowforge-api',
};

function service(overrides: Partial<Env> = {}) {
  const values = { ...env, ...overrides };
  const config = { get: (key: keyof Env) => values[key] } as unknown as AppConfigService;
  return new TokenService(new JwtService(), config);
}

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('TokenService', () => {
  const tokens = service();

  it('issues an access token that verifies to the user id', () => {
    const token = tokens.issueAccessToken('user-1');
    expect(tokens.verifyAccessToken(token)).toEqual({ userId: 'user-1' });
  });

  it('reports the access-token lifetime in seconds', () => {
    expect(tokens.accessTokenTtlSeconds).toBe(900);
    expect(tokens.refreshTokenTtlMs).toBe(7 * 24 * 3600 * 1000);
  });

  it('rejects an expired token', () => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    try {
      const token = tokens.issueAccessToken('user-1');
      jest.setSystemTime(new Date('2026-01-01T00:16:00Z'));
      expect(tokens.verifyAccessToken(token)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a token signed with another secret', () => {
    const foreign = service({ JWT_ACCESS_SECRET: 'x'.repeat(32) }).issueAccessToken('user-1');
    expect(tokens.verifyAccessToken(foreign)).toBeNull();
  });

  it('rejects a token for another audience or issuer', () => {
    expect(
      tokens.verifyAccessToken(service({ JWT_AUDIENCE: 'other' }).issueAccessToken('u')),
    ).toBeNull();
    expect(
      tokens.verifyAccessToken(service({ JWT_ISSUER: 'other' }).issueAccessToken('u')),
    ).toBeNull();
  });

  it('rejects an unsigned "alg: none" token', () => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({
      sub: 'user-1',
      typ: 'access',
      iss: 'flowforge',
      aud: 'flowforge-api',
      exp: now + 60,
    })}.`;
    expect(tokens.verifyAccessToken(unsigned)).toBeNull();
  });

  it('rejects a correctly signed token of another type', () => {
    const jwt = new JwtService();
    const refreshTyped = jwt.sign(
      { typ: 'refresh' },
      {
        secret: env.JWT_ACCESS_SECRET,
        subject: 'user-1',
        issuer: 'flowforge',
        audience: 'flowforge-api',
        expiresIn: 60,
      },
    );
    expect(tokens.verifyAccessToken(refreshTyped)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(tokens.verifyAccessToken('not-a-jwt')).toBeNull();
  });

  it('generates unique opaque refresh tokens and stores only their keyed hash', () => {
    const a = tokens.generateRefreshToken();
    const b = tokens.generateRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.hash).toBe(
      createHmac('sha256', env.JWT_REFRESH_SECRET!).update(a.token).digest('hex'),
    );
    expect(a.hash).not.toContain(a.token);
  });
});
