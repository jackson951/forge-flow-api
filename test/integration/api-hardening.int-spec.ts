import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { IS_PUBLIC_KEY } from '../../src/common/constants';
import { REQUIRED_ROLE_KEY } from '../../src/common/decorators/require-role.decorator';
import { AppConfigService } from '../../src/config/app-config.service';
import { Env } from '../../src/config/env.schema';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/infrastructure/redis/redis.module';
import Redis from 'ioredis';
import { bearer, registerUser, RegisteredUser, uniqueEmail } from '../support/auth';
import { createTestApp } from '../support/create-app';
import { fillPath, listRoutes } from '../support/routes';
import { truncateAll } from '../support/test-database';

/** Rate limiting on (other suites disable it) and one trusted proxy hop. */
class HardenedConfig extends AppConfigService {
  override get throttleEnabled(): boolean {
    return true;
  }
  override get<K extends keyof Env>(key: K): Env[K] {
    return (key === 'TRUST_PROXY' ? 1 : super.get(key)) as Env[K];
  }
}

/**
 * AC-18.4: the expected access level of every route. A new route without an entry here fails
 * the inventory test, so its authorization has to be decided explicitly.
 * public = no token; user = any authenticated user; member/admin/owner = workspace role.
 */
const EXPECTED_ACCESS: Record<string, 'public' | 'user' | 'member' | 'admin' | 'owner'> = {
  'GET /api/v1/health': 'public',
  'GET /api/v1/health/ready': 'public',
  'POST /api/v1/auth/register': 'public',
  'POST /api/v1/auth/login': 'public',
  'POST /api/v1/auth/refresh': 'public',
  'POST /api/v1/auth/logout': 'public', // revokes the refresh cookie it is given
  'POST /api/v1/auth/logout-all': 'user',
  'GET /api/v1/auth/me': 'user',
  'GET /api/v1/node-types': 'user',
  'POST /api/v1/webhooks/:provider': 'public',
  'GET /api/v1/integrations/providers': 'user',
  'GET /api/v1/integrations/:provider/callback': 'public',
  'GET /api/v1/workspaces': 'user',
  'POST /api/v1/workspaces': 'user',
  'GET /api/v1/workspaces/:workspaceId': 'member',
  'PATCH /api/v1/workspaces/:workspaceId': 'admin',
  'DELETE /api/v1/workspaces/:workspaceId': 'owner',
  'GET /api/v1/workspaces/:workspaceId/members': 'member',
  'POST /api/v1/workspaces/:workspaceId/members': 'admin',
  'PATCH /api/v1/workspaces/:workspaceId/members/:userId': 'admin',
  // Members may remove themselves (leave); removing others needs ADMIN (WorkspacePolicy).
  'DELETE /api/v1/workspaces/:workspaceId/members/:userId': 'member',
  'GET /api/v1/workspaces/:workspaceId/workflows': 'member',
  'POST /api/v1/workspaces/:workspaceId/workflows': 'member',
  'GET /api/v1/workspaces/:workspaceId/workflows/:id': 'member',
  'PATCH /api/v1/workspaces/:workspaceId/workflows/:id': 'member',
  'PUT /api/v1/workspaces/:workspaceId/workflows/:id/draft': 'member',
  'POST /api/v1/workspaces/:workspaceId/workflows/:id/validate': 'member',
  'POST /api/v1/workspaces/:workspaceId/workflows/:id/duplicate': 'member',
  'POST /api/v1/workspaces/:workspaceId/workflows/:id/archive': 'admin',
  'POST /api/v1/workspaces/:workspaceId/workflows/:id/unarchive': 'admin',
  'POST /api/v1/workspaces/:workspaceId/workflows/:id/publish': 'admin',
  'DELETE /api/v1/workspaces/:workspaceId/workflows/:id': 'admin',
  'GET /api/v1/workspaces/:workspaceId/workflows/:id/versions': 'member',
  'GET /api/v1/workspaces/:workspaceId/workflows/:id/versions/:version': 'member',
  'POST /api/v1/workspaces/:workspaceId/workflows/:workflowId/runs': 'member',
  'GET /api/v1/workspaces/:workspaceId/runs': 'member',
  'GET /api/v1/workspaces/:workspaceId/runs/:id': 'member',
  'GET /api/v1/workspaces/:workspaceId/runs/:id/steps': 'member',
  'POST /api/v1/workspaces/:workspaceId/runs/:id/retry': 'admin',
  'POST /api/v1/workspaces/:workspaceId/runs/:id/cancel': 'admin',
  'GET /api/v1/workspaces/:workspaceId/dashboard': 'member',
  'GET /api/v1/workspaces/:workspaceId/integrations': 'member',
  'POST /api/v1/workspaces/:workspaceId/integrations/:provider/connect': 'admin',
  'GET /api/v1/workspaces/:workspaceId/integrations/:connectionId/github/repositories': 'member',
  'GET /api/v1/workspaces/:workspaceId/integrations/:connectionId/slack/channels': 'member',
  'GET /api/v1/workspaces/:workspaceId/integrations/:connectionId/microsoft/todo-lists': 'member',
  'DELETE /api/v1/workspaces/:workspaceId/integrations/:connectionId': 'admin',
  // Part 24: HTTP connections (credential form).
  'POST /api/v1/workspaces/:workspaceId/integrations/http': 'admin',
  'POST /api/v1/workspaces/:workspaceId/integrations/:connectionId/test': 'admin',
  'PATCH /api/v1/workspaces/:workspaceId/integrations/:connectionId': 'admin',
  'PUT /api/v1/workspaces/:workspaceId/integrations/:connectionId/credentials': 'admin',
};

describe('API hardening (integration, Part 18)', () => {
  let a: NestExpressApplication;
  let b: NestExpressApplication;
  let serverA: App;
  let serverB: App;
  let prisma: PrismaService;
  let owner: RegisteredUser;
  let other: RegisteredUser;
  let ws: string;

  /** Each test speaks from its own client IP (X-Forwarded-For, trusted one hop). */
  // Unique per call: a random pick could repeat and share a rate-limit counter.
  let nextIp = Math.floor(Math.random() * 100);
  const ip = () => `203.0.${113 + Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`;
  const from = (server: App, clientIp: string) => ({
    post: (path: string) => request(server).post(path).set('X-Forwarded-For', clientIp),
    get: (path: string) => request(server).get(path).set('X-Forwarded-For', clientIp),
  });

  beforeAll(async () => {
    // Users are created with rate limiting off (registration is limited to 5/min per IP).
    const setup = await createTestApp();
    prisma = setup.get(PrismaService);
    await truncateAll(prisma);
    owner = await registerUser(setup.getHttpServer());
    other = await registerUser(setup.getHttpServer());
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: owner.id } }))
      .workspaceId;
    await setup.close();

    // Two API instances sharing one Redis, as in a scaled deployment.
    a = await createTestApp((x) => x.overrideProvider(AppConfigService).useClass(HardenedConfig));
    b = await createTestApp((x) => x.overrideProvider(AppConfigService).useClass(HardenedConfig));
    serverA = a.getHttpServer();
    serverB = b.getHttpServer();
  });

  afterAll(async () => {
    await a?.close();
    await b?.close();
  });

  describe('rate limits (AC-18.1, AC-18.2)', () => {
    const login = (server: App, clientIp: string, email: string) =>
      from(server, clientIp)
        .post('/api/v1/auth/login')
        .send({ email, password: 'wrong password guess' });

    it('login: 5/min per IP+email, counted across both instances, with Retry-After', async () => {
      const clientIp = ip();
      const email = uniqueEmail('target');
      for (let i = 0; i < 5; i++) {
        const server = i % 2 === 0 ? serverA : serverB;
        expect((await login(server, clientIp, email)).status).toBe(401);
      }
      const blocked = await login(serverB, clientIp, email);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(blocked.body).toMatchObject({ statusCode: 429, error: 'Too Many Requests' });
      // Another account from the same IP, and the same account from another IP, still work.
      expect((await login(serverA, clientIp, uniqueEmail('other'))).status).toBe(401);
      expect((await login(serverA, ip(), email)).status).toBe(401);
    });

    it('login: 20/min per IP across different emails', async () => {
      const clientIp = ip();
      for (let i = 0; i < 20; i++) {
        expect(
          (await login(i % 2 ? serverA : serverB, clientIp, uniqueEmail(`spray${i}`))).status,
        ).toBe(401);
      }
      expect((await login(serverA, clientIp, uniqueEmail('spray-last'))).status).toBe(429);
    });

    it('register: 5/min per IP', async () => {
      const clientIp = ip();
      const register = (server: App) =>
        from(server, clientIp)
          .post('/api/v1/auth/register')
          .send({ email: 'not-an-email', password: 'x', name: 'x' });
      for (let i = 0; i < 5; i++)
        expect((await register(i % 2 ? serverA : serverB)).status).toBe(400);
      expect((await register(serverA)).status).toBe(429);
    });

    it('refresh: 30/min per IP', async () => {
      const clientIp = ip();
      const refresh = (server: App) =>
        from(server, clientIp).post('/api/v1/auth/refresh').send({ refreshToken: 'not-valid' });
      for (let i = 0; i < 30; i++)
        expect((await refresh(i % 2 ? serverA : serverB)).status).toBe(401);
      expect((await refresh(serverB)).status).toBe(429);
    });

    it('authenticated API: 300/min per user, independent of other users', async () => {
      const me = (server: App, user: RegisteredUser) =>
        from(server, ip()).get('/api/v1/auth/me').set(bearer(user.accessToken));
      const statuses = await Promise.all(
        Array.from({ length: 300 }, (_, i) =>
          me(i % 2 ? serverA : serverB, owner).then((r) => r.status),
        ),
      );
      expect(statuses.every((s) => s === 200)).toBe(true);
      const blocked = await me(serverA, owner);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect((await me(serverB, other)).status).toBe(200);
    });

    it('webhooks: 600/min per provider per IP', async () => {
      const clientIp = ip();
      const hook = (server: App, provider: string) =>
        from(server, clientIp)
          .post(`/api/v1/webhooks/${provider}`)
          .set({ 'content-type': 'application/json', 'x-flowforge-delivery': randomUUID() })
          .send('{}');
      const statuses: number[] = [];
      for (let batch = 0; batch < 6; batch++) {
        statuses.push(
          ...(await Promise.all(
            Array.from({ length: 100 }, (_, i) =>
              hook(i % 2 ? serverA : serverB, 'test').then((r) => r.status),
            ),
          )),
        );
      }
      expect(statuses.filter((s) => s === 429)).toEqual([]);
      expect((await hook(serverA, 'test')).status).toBe(429);
      expect((await hook(serverA, 'github')).status).not.toBe(429); // other provider, own budget
    });
  });

  it('fails open when Redis is unavailable: requests still work, unthrottled (Part 19 fix)', async () => {
    const redis = a.get<Redis>(REDIS_CLIENT);
    const evalSpy = jest
      .spyOn(redis, 'eval')
      .mockRejectedValue(
        new Error("Stream isn't writeable and enableOfflineQueue options is false"),
      );
    try {
      const clientIp = ip();
      for (let i = 0; i < 7; i++) {
        const res = await from(serverA, clientIp)
          .post('/api/v1/auth/login')
          .send({ email: 'nobody@example.test', password: 'wrong password guess' });
        expect(res.status).toBe(401); // not 500, and not 429 (limits suspended)
      }
    } finally {
      evalSpy.mockRestore();
    }
  });

  describe('payloads (AC-18.3)', () => {
    it('JSON bodies above 300 KB → 413; webhooks accept up to 1 MB', async () => {
      const big = JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(310 * 1024) });
      const res = await from(serverA, ip())
        .post('/api/v1/auth/login')
        .set('content-type', 'application/json')
        .send(big);
      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({ statusCode: 413 });
      expect(res.text).not.toContain('xxxx');

      // ~400 KB body (over the 300 KB API limit) whose event data stays under the 256 KB cap.
      const hookBody = JSON.stringify({
        resource: 'r',
        data: { pad: 'y'.repeat(200 * 1024) },
        extra: 'e'.repeat(200 * 1024),
      });
      const ts = Math.floor(Date.now() / 1000);
      const sig = createHmac('sha256', process.env.WEBHOOK_TEST_SECRET!)
        .update(`${ts}.${hookBody}`)
        .digest('hex');
      const hook = await from(serverA, ip())
        .post('/api/v1/webhooks/test')
        .set({
          'content-type': 'application/json',
          'x-flowforge-delivery': randomUUID(),
          'x-flowforge-event': 'e',
          'x-flowforge-timestamp': String(ts),
          'x-flowforge-signature': `sha256=${sig}`,
        })
        .send(hookBody);
      expect(hook.status).toBe(202);
      const tooBig = await from(serverA, ip())
        .post('/api/v1/webhooks/test')
        .set('content-type', 'application/json')
        .send(JSON.stringify({ pad: 'z'.repeat(1100 * 1024) }));
      expect(tooBig.status).toBe(413);
    });

    it('URL-encoded bodies are not parsed (no form submissions to the API)', async () => {
      const res = await from(serverA, ip())
        .post('/api/v1/auth/register')
        .type('form')
        .send({
          email: uniqueEmail('form'),
          password: 'correct horse battery staple',
          name: 'Form',
        });
      expect(res.status).toBe(400);
      expect(await prisma.user.count({ where: { name: 'Form' } })).toBe(0);
    });

    it('malformed JSON → 400 envelope without echoing the input', async () => {
      const res = await from(serverA, ip())
        .post('/api/v1/auth/login')
        .set('content-type', 'application/json')
        .send('{"email": "secret-value-in-body"');
      expect(res.status).toBe(400);
      expect(res.text).not.toContain('secret-value-in-body');
    });
  });

  describe('limits on lists and workflows (AC-18.5)', () => {
    it('pagination limit is capped at 100 everywhere', async () => {
      const wf = await from(serverA, ip())
        .post(`/api/v1/workspaces/${ws}/workflows`)
        .set(bearer(owner.accessToken))
        .send({ name: 'Limits' })
        .expect(201);
      for (const path of [
        `/api/v1/workspaces/${ws}/runs`,
        `/api/v1/workspaces/${ws}/workflows`,
        `/api/v1/workspaces/${ws}/workflows/${wf.body.id}/versions`,
      ]) {
        const tooMany = await from(serverA, ip())
          .get(`${path}?limit=101`)
          .set(bearer(owner.accessToken));
        expect([path, tooMany.status]).toEqual([path, 400]);
        const max = await from(serverA, ip())
          .get(`${path}?limit=100`)
          .set(bearer(owner.accessToken));
        expect([path, max.status]).toEqual([path, 200]);
      }
    });

    it('workflow size limits: 50 nodes, 100 edges, 256 KB definition', async () => {
      const wf = await from(serverA, ip())
        .post(`/api/v1/workspaces/${ws}/workflows`)
        .set(bearer(owner.accessToken))
        .send({ name: 'Huge' })
        .expect(201);
      const node = (i: number) => ({
        key: `n${i}`,
        kind: i === 0 ? 'TRIGGER' : 'ACTION',
        type: i === 0 ? 'manual.trigger' : 'util.log',
        config: i === 0 ? {} : { message: 'x' },
      });
      const nodes = Array.from({ length: 51 }, (_, i) => node(i));
      const edges = nodes.slice(1).map((n, i) => ({ from: `n${i}`, to: n.key }));
      const res = await request(serverA)
        .put(`/api/v1/workspaces/${ws}/workflows/${wf.body.id}/draft`)
        .set({ ...bearer(owner.accessToken), 'X-Forwarded-For': ip() })
        .send({ expectedRevision: 0, definition: { schemaVersion: 1, nodes, edges } });
      // Oversized drafts are refused outright (not saved with issues).
      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([
        expect.objectContaining({ code: 'LIMIT_EXCEEDED', message: 'At most 50 nodes' }),
      ]);

      const putDraft = (definition: object) =>
        request(serverA)
          .put(`/api/v1/workspaces/${ws}/workflows/${wf.body.id}/draft`)
          .set({ ...bearer(owner.accessToken), 'X-Forwarded-For': ip() })
          .send({ expectedRevision: 0, definition });
      const manyEdges = await putDraft({
        schemaVersion: 1,
        nodes: nodes.slice(0, 50),
        edges: Array.from({ length: 101 }, (_, i) => ({ from: 'n0', to: `n${(i % 49) + 1}` })),
      });
      expect(manyEdges.status).toBe(400);
      expect(manyEdges.body.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'At most 100 edges' })]),
      );
      const heavy = await putDraft({
        schemaVersion: 1,
        nodes: Array.from({ length: 20 }, (_, i) => ({
          ...node(i),
          config: i ? { message: 'm'.repeat(14 * 1024) } : {},
        })),
        edges: [],
      });
      expect(heavy.status).toBe(400);
      expect(heavy.body.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'Definition exceeds 256 KB' })]),
      );
      expect(
        (await prisma.workflow.findUniqueOrThrow({ where: { id: wf.body.id } })).draftRevision,
      ).toBe(0);
    });
  });

  describe('headers and CORS', () => {
    it('API responses deny everything by CSP and set hardening headers', async () => {
      const res = await from(serverA, ip()).get('/api/v1/health/live');
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'none';frame-ancestors 'none'",
      );
      expect(res.headers).toMatchObject({
        'cross-origin-resource-policy': 'same-site',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'SAMEORIGIN',
        'referrer-policy': 'no-referrer',
        'strict-transport-security': expect.stringContaining('max-age='),
      });
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('the Swagger UI keeps a policy that lets it load its own assets', async () => {
      const res = await from(serverA, ip()).get('/api/docs');
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    });

    it('CORS allows only configured origins, with credentials and an explicit allow-list', async () => {
      const allowed = 'http://localhost:5173';
      const ok = await request(serverA)
        .options('/api/v1/auth/login')
        .set({ Origin: allowed, 'Access-Control-Request-Method': 'POST' });
      expect(ok.headers['access-control-allow-origin']).toBe(allowed);
      expect(ok.headers['access-control-allow-credentials']).toBe('true');
      expect(ok.headers['access-control-allow-methods']).toBe('GET,POST,PUT,PATCH,DELETE');
      expect(ok.headers['access-control-allow-headers']).toBe(
        'Authorization,Content-Type,Idempotency-Key,x-request-id',
      );

      const evil = await request(serverA)
        .options('/api/v1/auth/login')
        .set({ Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' });
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('authorization review (AC-18.4)', () => {
    /** Every controller method with its effective access, read from the decorators. */
    function inventory(app: NestExpressApplication): Record<string, string> {
      const result: Record<string, string> = {};
      for (const module of app.get(ModulesContainer).values()) {
        for (const wrapper of module.controllers.values()) {
          const controller = wrapper.metatype as { prototype: Record<string, unknown> } & object;
          const basePath = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
          for (const name of Object.getOwnPropertyNames(controller.prototype)) {
            const handler = controller.prototype[name] as object;
            if (typeof handler !== 'function' || name === 'constructor') continue;
            const path = Reflect.getMetadata(PATH_METADATA, handler);
            if (path === undefined) continue;
            const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
            const full = `/api/v1/${[basePath, path].filter((p) => p && p !== '/').join('/')}`;
            const isPublic =
              Reflect.getMetadata(IS_PUBLIC_KEY, handler) ??
              Reflect.getMetadata(IS_PUBLIC_KEY, controller);
            const role =
              Reflect.getMetadata(REQUIRED_ROLE_KEY, handler) ??
              Reflect.getMetadata(REQUIRED_ROLE_KEY, controller);
            result[`${method} ${full}`] = isPublic
              ? 'public'
              : role
                ? String(role).toLowerCase()
                : full.includes(':workspaceId')
                  ? 'member'
                  : 'user';
          }
        }
      }
      return result;
    }

    it('every route has an explicit, reviewed access expectation', () => {
      const actual = inventory(a);
      expect(actual).toEqual(EXPECTED_ACCESS);
      // The inventory covers every route the router actually serves.
      // Versioned API routes only (excludes the Swagger UI and Nest's not-found catch-alls).
      const served = [
        ...new Set(
          listRoutes(a)
            .filter((r) => r.path.startsWith('/api/v1/') && !r.path.includes('{*'))
            .map((r) => `${r.method} ${r.path}`),
        ),
      ];
      expect(served.sort()).toEqual(Object.keys(EXPECTED_ACCESS).sort());
    });

    it('malformed ids are rejected (400/404), never a 2xx or 500', async () => {
      const failures: string[] = [];
      // The OAuth callback is public and always redirects to the frontend with a generic
      // reason (checked below), so it is not part of this check.
      const callback = await request(serverA).get('/api/v1/integrations/not-a-valid-id/callback');
      expect(callback.status).toBe(302);
      expect(callback.headers.location).toContain('reason=unknown_provider');
      for (const route of listRoutes(a).filter(
        (r) => /:(?!workspaceId)\w+/.test(r.path) && !r.path.endsWith('/callback'),
      )) {
        const path = fillPath(route.path, { workspaceId: ws }, () => 'not-a-valid-id');
        const res = await request(serverA)
          [route.method.toLowerCase() as 'get']('/' + path.replace(/^\//, ''))
          .set({ ...bearer(owner.accessToken), 'X-Forwarded-For': ip() })
          .send({});
        if (res.status < 400 || res.status >= 500)
          failures.push(`${route.method} ${route.path} → ${res.status}`);
      }
      expect(failures).toEqual([]);
    });
  });
});
