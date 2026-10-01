import { JwtService } from '@nestjs/jwt';
import { NestExpressApplication } from '@nestjs/platform-express';
import request, { Response } from 'supertest';
import { App } from 'supertest/types';
import { AppConfigService } from '../../src/config/app-config.service';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { REUSE_GRACE_MS } from '../../src/modules/auth/auth.service';
import { bearer, registerUser, TEST_PASSWORD, uniqueEmail } from '../support/auth';
import { createTestApp } from '../support/create-app';
import { truncateAll } from '../support/test-database';
import { DEMO_EMAIL, seed } from '../../prisma/seed';

describe('Authentication (integration)', () => {
  let app: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  /** Every response body seen, for the "no password hash ever leaves the API" check. */
  const seenBodies: string[] = [];

  const http = () => {
    const agent = request(server);
    const record = (res: Response) => {
      seenBodies.push(res.text ?? '');
      return res;
    };
    return {
      post: (url: string, body?: object, headers: Record<string, string> = {}) =>
        agent.post(url).set(headers).send(body).then(record),
      get: (url: string, headers: Record<string, string> = {}) =>
        agent.get(url).set(headers).then(record),
    };
  };

  const login = (email: string, password = TEST_PASSWORD) =>
    http().post('/api/v1/auth/login', { email, password });
  const refresh = (refreshToken: string) => http().post('/api/v1/auth/refresh', { refreshToken });

  /** Moves the rotation time of the user's rotated tokens into the past. */
  const backdateRotation = (userId: string, ms: number) =>
    prisma.refreshToken.updateMany({
      where: { userId, replacedById: { not: null } },
      data: { revokedAt: new Date(Date.now() - ms) },
    });

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
    await truncateAll(prisma);
  });

  afterAll(async () => {
    // AC-03.9: checked across every response produced by this suite.
    const all = seenBodies.join('\n');
    expect(all).not.toContain('passwordHash');
    expect(all).not.toContain('$argon2');
    await app.close();
  });

  describe('register', () => {
    it('creates the user, a personal workspace and a session (AC-03.1)', async () => {
      const email = uniqueEmail('ada');
      const res = await http().post('/api/v1/auth/register', {
        email,
        password: TEST_PASSWORD,
        name: 'Ada',
      });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        user: { id: expect.any(String), email, name: 'Ada', createdAt: expect.any(String) },
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        expiresIn: 900,
      });

      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toContain(`ff_refresh=${res.body.refreshToken}`);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.passwordHash).not.toContain(TEST_PASSWORD);

      const memberships = await prisma.workspaceMember.findMany({ where: { userId: user.id } });
      expect(memberships).toEqual([expect.objectContaining({ role: 'OWNER' })]);
      expect(
        await prisma.auditEvent.count({ where: { action: 'auth.register', actorUserId: user.id } }),
      ).toBe(1);
    });

    it('normalises the email to lower case', async () => {
      const res = await http().post('/api/v1/auth/register', {
        email: '  Grace.Hopper@Example.TEST ',
        password: TEST_PASSWORD,
        name: 'Grace',
      });
      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe('grace.hopper@example.test');
    });

    it('rejects a duplicate email regardless of case (AC-03.2)', async () => {
      const email = uniqueEmail('dup');
      await registerUser(server, email);
      const res = await http().post('/api/v1/auth/register', {
        email: email.toUpperCase(),
        password: TEST_PASSWORD,
        name: 'Dup',
      });
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('An account with this email already exists');
    });

    it('rejects weak or malformed input', async () => {
      const res = await http().post('/api/v1/auth/register', {
        email: 'nope',
        password: 'short',
        name: '',
      });
      expect(res.status).toBe(400);
      const fields = (res.body.details as { field: string }[]).map((d) => d.field).sort();
      expect(fields).toEqual(['email', 'name', 'password']);
    });
  });

  describe('login', () => {
    it('returns a session for valid credentials (AC-03.3)', async () => {
      const { email } = await registerUser(server);
      const res = await login(email.toUpperCase());
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(email);
      expect(res.body.accessToken).toEqual(expect.any(String));
    });

    it('answers a wrong password and an unknown email identically (AC-03.4)', async () => {
      const { email, id } = await registerUser(server);
      const wrongPassword = await login(email, 'not the right password');
      const unknownEmail = await login(uniqueEmail('ghost'));

      const comparable = (res: Response) => ({
        status: res.status,
        message: res.body.message,
        error: res.body.error,
      });
      expect(comparable(wrongPassword)).toEqual({
        status: 401,
        message: 'Invalid email or password',
        error: 'Unauthorized',
      });
      expect(comparable(unknownEmail)).toEqual(comparable(wrongPassword));

      const failures = await prisma.auditEvent.findMany({ where: { action: 'auth.login.failed' } });
      expect(failures.find((e) => e.actorUserId === id)).toBeDefined();
      expect(JSON.stringify(failures)).not.toContain(email);
      expect(JSON.stringify(failures)).not.toContain('not the right password');
    });
  });

  describe('development seed', () => {
    it('a demo user seeded with SEED_DEMO_PASSWORD can log in', async () => {
      await seed(prisma, 'demo-password-for-tests');
      expect((await login(DEMO_EMAIL, 'demo-password-for-tests')).status).toBe(200);
    });
  });

  describe('protected routes (AC-03.5)', () => {
    it('returns the current user with a valid access token', async () => {
      const user = await registerUser(server);
      const res = await http().get('/api/v1/auth/me', bearer(user.accessToken));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: user.id,
        email: user.email,
        name: 'Test User',
        createdAt: expect.any(String),
      });
    });

    it.each([
      ['no token', {}],
      ['malformed token', bearer('not-a-jwt')],
      ['wrong scheme', { Authorization: 'Basic abc' }],
    ])('rejects %s', async (_label, headers) => {
      const res = await http().get('/api/v1/auth/me', headers as Record<string, string>);
      expect(res.status).toBe(401);
    });

    it('rejects an expired access token', async () => {
      const user = await registerUser(server);
      const config = app.get(AppConfigService);
      const expired = new JwtService().sign(
        { typ: 'access', exp: Math.floor(Date.now() / 1000) - 60 },
        {
          secret: config.get('JWT_ACCESS_SECRET'),
          subject: user.id,
          issuer: config.get('JWT_ISSUER'),
          audience: config.get('JWT_AUDIENCE'),
        },
      );
      expect((await http().get('/api/v1/auth/me', bearer(expired))).status).toBe(401);
    });

    it('rejects a refresh token used as an access token', async () => {
      const user = await registerUser(server);
      expect((await http().get('/api/v1/auth/me', bearer(user.refreshToken))).status).toBe(401);
    });

    it('rejects a valid token whose user no longer exists', async () => {
      const user = await registerUser(server);
      await prisma.user.delete({ where: { id: user.id } });
      expect((await http().get('/api/v1/auth/me', bearer(user.accessToken))).status).toBe(401);
    });
  });

  describe('refresh', () => {
    it('rotates the token pair; the old refresh token stops working (AC-03.6)', async () => {
      const user = await registerUser(server);
      const res = await refresh(user.refreshToken);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        expiresIn: 900,
      });
      expect(res.body.refreshToken).not.toBe(user.refreshToken);
      expect((await http().get('/api/v1/auth/me', bearer(res.body.accessToken))).status).toBe(200);

      expect((await refresh(res.body.refreshToken)).status).toBe(200);
    });

    it('accepts the refresh token from the HttpOnly cookie', async () => {
      const user = await registerUser(server);
      const res = await request(server)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `ff_refresh=${user.refreshToken}`)
        .send({});
      expect(res.status).toBe(200);
      expect(String(res.headers['set-cookie'])).toContain(`ff_refresh=${res.body.refreshToken}`);
    });

    it('revokes the whole family when a rotated token is reused (AC-03.7)', async () => {
      const user = await registerUser(server);
      const first = await refresh(user.refreshToken);
      expect(first.status).toBe(200);
      await backdateRotation(user.id, REUSE_GRACE_MS + 1_000);

      const replay = await refresh(user.refreshToken);
      expect(replay.status).toBe(401);
      // The legitimately rotated token is now dead too.
      expect((await refresh(first.body.refreshToken)).status).toBe(401);

      const active = await prisma.refreshToken.count({
        where: { userId: user.id, revokedAt: null },
      });
      expect(active).toBe(0);
      expect(
        await prisma.auditEvent.count({
          where: { action: 'auth.refresh.reuse_detected', actorUserId: user.id },
        }),
      ).toBe(1);
    });

    it('rejects a replay inside the grace window without logging the user out', async () => {
      const user = await registerUser(server);
      const first = await refresh(user.refreshToken);
      expect((await refresh(user.refreshToken)).status).toBe(401);
      expect((await refresh(first.body.refreshToken)).status).toBe(200);
    });

    it('lets exactly one of two concurrent refreshes with the same token win', async () => {
      const user = await registerUser(server);
      const results = await Promise.all([refresh(user.refreshToken), refresh(user.refreshToken)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
      expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(
        1,
      );
    });

    it('rejects an expired refresh token', async () => {
      const user = await registerUser(server);
      await prisma.refreshToken.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await refresh(user.refreshToken)).status).toBe(401);
    });

    it('rejects unknown or missing tokens', async () => {
      expect((await refresh('does-not-exist')).status).toBe(401);
      expect((await http().post('/api/v1/auth/refresh', {})).status).toBe(401);
    });

    it('stores refresh tokens only as hashes', async () => {
      const user = await registerUser(server);
      const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
      expect(JSON.stringify(rows)).not.toContain(user.refreshToken);
    });
  });

  describe('logout (AC-03.8)', () => {
    it('logout invalidates that session’s refresh token and clears the cookie', async () => {
      const user = await registerUser(server);
      const res = await http().post('/api/v1/auth/logout', { refreshToken: user.refreshToken });
      expect(res.status).toBe(204);
      expect(String(res.headers['set-cookie'])).toMatch(/ff_refresh=;/);
      expect((await refresh(user.refreshToken)).status).toBe(401);
    });

    it('logout is idempotent and does not reveal whether a token existed', async () => {
      expect((await http().post('/api/v1/auth/logout', { refreshToken: 'unknown' })).status).toBe(
        204,
      );
      expect((await http().post('/api/v1/auth/logout', {})).status).toBe(204);
    });

    it('logout only ends its own session', async () => {
      const user = await registerUser(server);
      const second = await login(user.email);
      await http().post('/api/v1/auth/logout', { refreshToken: user.refreshToken });
      expect((await refresh(second.body.refreshToken)).status).toBe(200);
    });

    it('logout-all invalidates every refresh token of the user', async () => {
      const user = await registerUser(server);
      const second = await login(user.email);
      const res = await http().post('/api/v1/auth/logout-all', {}, bearer(user.accessToken));
      expect(res.status).toBe(204);
      expect((await refresh(user.refreshToken)).status).toBe(401);
      expect((await refresh(second.body.refreshToken)).status).toBe(401);
    });

    it('logout-all requires authentication', async () => {
      expect((await http().post('/api/v1/auth/logout-all', {})).status).toBe(401);
    });

    it('documented limitation: an issued access token stays valid until it expires', async () => {
      const user = await registerUser(server);
      await http().post('/api/v1/auth/logout-all', {}, bearer(user.accessToken));
      expect((await http().get('/api/v1/auth/me', bearer(user.accessToken))).status).toBe(200);
    });
  });
});
