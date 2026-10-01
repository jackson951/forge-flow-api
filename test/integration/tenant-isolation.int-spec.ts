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
  let bobWorkflowId: string;

  /**
   * Resource routes and a resource of Bob's to aim at them. Each later part adds its
   * resource here (runs, connections, ...); routes are still discovered automatically.
   */
  const foreignResources = (): { pattern: RegExp; param: string; id: string }[] => [
    { pattern: /\/workflows\/:id(\/|$)/, param: 'id', id: bobWorkflowId },
  ];

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
    workflows: await prisma.workflow.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } }),
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

    bobWorkflowId = (
      await request(server)
        .post(`/api/v1/workspaces/${bobWs}/workflows`)
        .set(bearer(bob.accessToken))
        .send({ name: "Bob's workflow" })
        .expect(201)
    ).body.id;
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

  it("treats another workspace's resource ids exactly like non-existent ones", async () => {
    // Body validation may legitimately answer before the lookup (e.g. 400 for an empty draft
    // body). The invariant is: never success, and no difference from a random unknown id.
    const before = await snapshot(bobWs);
    const failures: string[] = [];
    let attacked = 0;

    for (const { pattern, param, id } of foreignResources()) {
      for (const route of workspaceRoutes.filter((r) => pattern.test(r.path))) {
        attacked++;
        const foreign = fillPath(route.path, { workspaceId: aliceWs, [param]: id }, paramValue);
        const unknown = fillPath(
          route.path,
          { workspaceId: aliceWs, [param]: randomUUID() },
          paramValue,
        );
        const a = await send(route, foreign, bearer(alice.accessToken));
        const b = await send(route, unknown, bearer(alice.accessToken));
        if (a.status < 400 || a.status !== b.status) {
          failures.push(`${route.method} ${route.path} → foreign ${a.status}, unknown ${b.status}`);
        }
      }
    }

    expect(attacked).toBeGreaterThanOrEqual(10);
    expect(failures).toEqual([]);
    expect(await snapshot(bobWs)).toEqual(before);
  });

  it("returns 404 for another workspace's workflow even with a valid request body", async () => {
    const base = `/api/v1/workspaces/${aliceWs}/workflows/${bobWorkflowId}`;
    const auth = bearer(alice.accessToken);
    await request(server).get(base).set(auth).expect(404);
    await request(server).patch(base).set(auth).send({ name: 'hijacked' }).expect(404);
    await request(server)
      .put(`${base}/draft`)
      .set(auth)
      .send({ expectedRevision: 0, definition: { schemaVersion: 1, nodes: [], edges: [] } })
      .expect(404);
    await request(server).post(`${base}/duplicate`).set(auth).expect(404);
    await request(server).delete(base).set(auth).expect(404);

    const bobs = await prisma.workflow.findUniqueOrThrow({ where: { id: bobWorkflowId } });
    expect(bobs).toMatchObject({ name: "Bob's workflow", draftRevision: 0, workspaceId: bobWs });
    expect(await prisma.workflow.count({ where: { workspaceId: aliceWs } })).toBe(0);
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
