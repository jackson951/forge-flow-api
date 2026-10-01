import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { createTestApp } from '../support/create-app';
import { fillPath, listRoutes, RouteInfo } from '../support/routes';
import { truncateAll } from '../support/test-database';

/**
 * Standing tenant-isolation suite (AC-04.3, AC-04.4, AC-04.7).
 *
 * Routes are discovered from the live router, so every route added later under
 * `/workspaces/:workspaceId/...` is attacked automatically — nobody has to remember to
 * register it here.
 */
describe('Tenant isolation (integration)', () => {
  let app: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let alice: RegisteredUser;
  let bob: RegisteredUser;
  let aliceWs: string;
  let bobWs: string;
  let workspaceRoutes: RouteInfo[];

  const paramValue = (name: string) => (name === 'provider' ? 'GITHUB' : randomUUID());

  const send = (route: RouteInfo, path: string, headers: Record<string, string> = {}) =>
    request(server)
      [route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](path)
      .set(headers)
      .send({});

  const snapshot = async (workspaceId: string) => ({
    workspace: await prisma.workspace.findUnique({ where: { id: workspaceId } }),
    members: await prisma.workspaceMember.findMany({
      where: { workspaceId },
      orderBy: { userId: 'asc' },
    }),
  });

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
    await truncateAll(prisma);

    alice = await registerUser(server);
    bob = await registerUser(server);
    aliceWs = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: alice.id } }))
      .workspaceId;
    bobWs = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: bob.id } }))
      .workspaceId;

    workspaceRoutes = listRoutes(app).filter((r) => r.path.includes(':workspaceId'));
  });

  afterAll(() => app.close());

  it('discovers the workspace-scoped routes', () => {
    // Sanity check that discovery works; grows as later parts add routes.
    expect(workspaceRoutes.length).toBeGreaterThanOrEqual(20);
    expect(workspaceRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining([
        'GET /api/v1/workspaces/:workspaceId',
        'DELETE /api/v1/workspaces/:workspaceId',
        'PATCH /api/v1/workspaces/:workspaceId/members/:userId',
        'POST /api/v1/workspaces/:workspaceId/workflows/:id/publish',
      ]),
    );
  });

  it('returns 404 for every workspace route when the caller is not a member, and changes nothing', async () => {
    const before = await snapshot(bobWs);
    const failures: string[] = [];

    for (const route of workspaceRoutes) {
      const path = fillPath(route.path, { workspaceId: bobWs, userId: bob.id }, paramValue);
      const res = await send(route, path, bearer(alice.accessToken));
      if (res.status !== 404) failures.push(`${route.method} ${route.path} → ${res.status}`);
    }

    expect(failures).toEqual([]);
    expect(await snapshot(bobWs)).toEqual(before);
  });

  it('returns 401 for every workspace route without a token', async () => {
    const failures: string[] = [];
    for (const route of workspaceRoutes) {
      const path = fillPath(route.path, { workspaceId: bobWs }, paramValue);
      const res = await send(route, path);
      if (res.status !== 401) failures.push(`${route.method} ${route.path} → ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('returns 404 (not 400/500) for malformed workspace ids', async () => {
    const failures: string[] = [];
    for (const route of workspaceRoutes) {
      const path = fillPath(route.path, { workspaceId: 'not-a-uuid' }, paramValue);
      const res = await send(route, path, bearer(alice.accessToken));
      if (res.status !== 404) failures.push(`${route.method} ${route.path} → ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it("cannot act on another workspace's member through one's own workspace path", async () => {
    const base = `/api/v1/workspaces/${aliceWs}/members/${bob.id}`;
    await request(server)
      .patch(base)
      .set(bearer(alice.accessToken))
      .send({ role: 'ADMIN' })
      .expect(404);
    await request(server).delete(base).set(bearer(alice.accessToken)).expect(404);

    const bobMembership = await prisma.workspaceMember.findMany({ where: { userId: bob.id } });
    expect(bobMembership).toEqual([expect.objectContaining({ workspaceId: bobWs, role: 'OWNER' })]);
  });

  it("does not list other users' workspaces", async () => {
    const res = await request(server).get('/api/v1/workspaces').set(bearer(alice.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.map((w: { id: string }) => w.id)).toEqual([aliceWs]);
  });

  it('the 404 for a foreign workspace is indistinguishable from a non-existent one', async () => {
    const foreign = await request(server)
      .get(`/api/v1/workspaces/${bobWs}`)
      .set(bearer(alice.accessToken));
    const missing = await request(server)
      .get(`/api/v1/workspaces/${randomUUID()}`)
      .set(bearer(alice.accessToken));
    const strip = (body: Record<string, unknown>) => ({
      statusCode: body.statusCode,
      error: body.error,
      message: body.message,
    });
    expect(strip(foreign.body)).toEqual(strip(missing.body));
  });
});
