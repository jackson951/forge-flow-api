import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types';
import { z } from 'zod';
import { NodeTypeCatalog } from '../../src/engine/catalog/node-type-catalog';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { createTestApp } from '../support/create-app';
import { createRun } from '../support/factories';
import { listRoutes } from '../support/routes';
import { truncateAll } from '../support/test-database';

const definition = (message: string, trigger: object = { type: 'manual.trigger', config: {} }) => ({
  schemaVersion: 1,
  nodes: [
    { key: 'trigger', kind: 'TRIGGER', ...trigger },
    { key: 'log', kind: 'ACTION', type: 'util.log', config: { message } },
  ],
  edges: [{ from: 'trigger', to: 'log' }],
});

describe('Workflow versioning and publishing (integration)', () => {
  let app: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let owner: RegisteredUser;
  let member: RegisteredUser;
  let ws: string;

  const base = () => `/api/v1/workspaces/${ws}/workflows`;
  const as = (user: RegisteredUser) => bearer(user.accessToken);

  async function workflowWithDraft(def: object = definition('v1')) {
    const created = await request(server)
      .post(base())
      .set(as(owner))
      .send({ name: 'wf' })
      .expect(201);
    await request(server)
      .put(`${base()}/${created.body.id}/draft`)
      .set(as(owner))
      .send({ expectedRevision: 0, definition: def })
      .expect(200);
    return created.body.id as string;
  }

  const saveDraft = (id: string, expectedRevision: number, def: object) =>
    request(server)
      .put(`${base()}/${id}/draft`)
      .set(as(owner))
      .send({ expectedRevision, definition: def })
      .expect(200);

  const publish = (id: string, expectedRevision: number, user = owner) =>
    request(server).post(`${base()}/${id}/publish`).set(as(user)).send({ expectedRevision });

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
    await truncateAll(prisma);

    // A webhook-style trigger so routing rows can be observed (real ones arrive in Part 10).
    app.get(NodeTypeCatalog).register({
      type: 'test.webhook',
      kind: 'TRIGGER',
      displayName: 'Test webhook',
      configSchema: z.object({ resource: z.string().min(1) }).strict(),
      route: (config) => ({
        provider: 'GITHUB',
        eventType: 'test.event',
        resourceKey: String(config.resource),
      }),
    });

    owner = await registerUser(server);
    member = await registerUser(server);
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: owner.id } }))
      .workspaceId;
    await request(server)
      .post(`/api/v1/workspaces/${ws}/members`)
      .set(as(owner))
      .send({ email: member.email, role: 'MEMBER' })
      .expect(201);
  });

  afterAll(() => app.close());

  it('refuses to publish an invalid draft and creates nothing (AC-06.1)', async () => {
    const created = await request(server).post(base()).set(as(owner)).send({ name: 'empty' });
    const res = await publish(created.body.id, 0);
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual([expect.objectContaining({ code: 'NO_TRIGGER' })]);
    expect(await prisma.workflowVersion.count({ where: { workflowId: created.body.id } })).toBe(0);
    const wf = await prisma.workflow.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(wf).toMatchObject({ status: 'DRAFT', activeVersionId: null });
  });

  it('publishes version 1 and activates it', async () => {
    const id = await workflowWithDraft();
    const res = await publish(id, 1);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      version: 1,
      schemaVersion: 1,
      definitionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      publishedAt: expect.any(String),
      publishedBy: { id: owner.id, name: 'Test User' },
      isActive: true,
    });

    const wf = await request(server).get(`${base()}/${id}`).set(as(member)).expect(200);
    expect(wf.body).toMatchObject({
      status: 'PUBLISHED',
      activeVersion: { id: res.body.id, version: 1 },
    });
    expect(
      await prisma.auditEvent.count({ where: { action: 'workflow.published', targetId: id } }),
    ).toBe(1);
  });

  it('rejects a stale revision and an unchanged draft', async () => {
    const id = await workflowWithDraft();
    expect((await publish(id, 0)).status).toBe(409);
    await publish(id, 1).expect(201);

    const again = await publish(id, 1);
    expect(again.status).toBe(409);
    expect(again.body.details).toEqual({ code: 'NO_CHANGES' });

    // Same content, different key order and whitespace → still "no changes" (canonical hash).
    const reordered = JSON.parse(JSON.stringify(definition('v1')), (_k, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).reverse())
        : v,
    );
    await saveDraft(id, 1, reordered);
    expect((await publish(id, 2)).body.details).toEqual({ code: 'NO_CHANGES' });
  });

  it('MEMBER cannot publish', async () => {
    const id = await workflowWithDraft();
    expect((await publish(id, 1, member)).status).toBe(403);
  });

  it('editing the draft and publishing creates v2 without touching v1 (AC-06.3)', async () => {
    const id = await workflowWithDraft(definition('first'));
    const v1 = (await publish(id, 1).expect(201)).body;
    const v1Row = await prisma.workflowVersion.findUniqueOrThrow({ where: { id: v1.id } });

    await saveDraft(id, 1, definition('second'));
    const v2 = (await publish(id, 2).expect(201)).body;
    expect(v2.version).toBe(2);
    expect(v2.definitionHash).not.toBe(v1.definitionHash);

    expect(await prisma.workflowVersion.findUniqueOrThrow({ where: { id: v1.id } })).toEqual(v1Row);
    const v1Api = await request(server)
      .get(`${base()}/${id}/versions/1`)
      .set(as(member))
      .expect(200);
    expect(v1Api.body).toMatchObject({
      version: 1,
      isActive: false,
      definitionHash: v1.definitionHash,
    });
    expect(v1Api.body.definition.nodes[1].config.message).toBe('first');
  });

  it('published versions cannot be modified through the API or SQL (AC-06.2)', async () => {
    const versionRoutes = listRoutes(app).filter((r) => r.path.includes('/versions'));
    expect(versionRoutes.map((r) => r.method).sort()).toEqual(['GET', 'GET']);

    const id = await workflowWithDraft();
    const v1 = (await publish(id, 1).expect(201)).body;
    await expect(
      prisma.$executeRaw`UPDATE "WorkflowVersion" SET definition = '{}'::jsonb WHERE id = ${v1.id}::uuid`,
    ).rejects.toThrow(/is immutable/);
    await request(server).delete(`${base()}/${id}/versions/1`).set(as(owner)).expect(404);
  });

  it('a run keeps resolving the exact version it executed after later publishes (AC-06.4)', async () => {
    const id = await workflowWithDraft(definition('ran with this'));
    const v1 = (await publish(id, 1).expect(201)).body;
    const run = await createRun(prisma, { id: v1.id, workflowId: id, workspaceId: ws });

    await saveDraft(id, 1, definition('changed later'));
    await publish(id, 2).expect(201);

    const reloaded = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
      include: { version: true },
    });
    expect(reloaded.version).toMatchObject({ version: 1, definitionHash: v1.definitionHash });
    expect(reloaded.version.definition).toMatchObject({
      nodes: [expect.anything(), expect.objectContaining({ config: { message: 'ran with this' } })],
    });
  });

  it('keeps version numbers gapless under concurrent publishes (AC-06.5)', async () => {
    const id = await workflowWithDraft(definition('a'));
    const results = await Promise.all([publish(id, 1), publish(id, 1), publish(id, 1)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);

    await saveDraft(id, 1, definition('b'));
    await publish(id, 2).expect(201);
    await saveDraft(id, 2, definition('c'));
    await publish(id, 3).expect(201);

    const versions = await prisma.workflowVersion.findMany({
      where: { workflowId: id },
      orderBy: { version: 'asc' },
    });
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it('lists version history newest first with publisher and pagination (AC-06.6)', async () => {
    const id = await workflowWithDraft(definition('1'));
    await publish(id, 1).expect(201);
    for (let i = 2; i <= 3; i++) {
      await saveDraft(id, i - 1, definition(String(i)));
      await publish(id, i).expect(201);
    }

    const page1 = await request(server).get(`${base()}/${id}/versions?limit=2`).set(as(member));
    expect(page1.status).toBe(200);
    expect(page1.body.items.map((v: { version: number }) => v.version)).toEqual([3, 2]);
    expect(page1.body.items[0]).toMatchObject({ isActive: true, publishedBy: { id: owner.id } });
    expect(page1.body.items[0]).not.toHaveProperty('definition');
    expect(page1.body.nextCursor).toBe('2');

    const page2 = await request(server)
      .get(`${base()}/${id}/versions?limit=2&cursor=${page1.body.nextCursor}`)
      .set(as(member));
    expect(page2.body).toEqual({
      items: [expect.objectContaining({ version: 1, isActive: false })],
      nextCursor: null,
    });

    await request(server).get(`${base()}/${id}/versions/99`).set(as(member)).expect(404);
    await request(server).get(`${base()}/${id}/versions/abc`).set(as(member)).expect(400);
  });

  describe('trigger routing', () => {
    const webhookDef = (resource: string) =>
      definition('hook', { type: 'test.webhook', config: { resource } });
    const routes = (workflowId: string) =>
      prisma.workflowTrigger.findMany({ where: { workflowId } });

    it('publishing activates routing for the new version; archive/unarchive toggle it', async () => {
      const id = await workflowWithDraft(webhookDef('owner/repo'));
      const v1 = (await publish(id, 1).expect(201)).body;
      expect(await routes(id)).toEqual([
        expect.objectContaining({
          workspaceId: ws,
          workflowVersionId: v1.id,
          provider: 'GITHUB',
          eventType: 'test.event',
          resourceKey: 'owner/repo',
        }),
      ]);

      await saveDraft(id, 1, webhookDef('owner/other'));
      const v2 = (await publish(id, 2).expect(201)).body;
      expect(await routes(id)).toEqual([
        expect.objectContaining({ workflowVersionId: v2.id, resourceKey: 'owner/other' }),
      ]);

      await request(server).post(`${base()}/${id}/archive`).set(as(owner)).expect(200);
      expect(await routes(id)).toEqual([]);
      expect((await publish(id, 2)).status).toBe(409); // archived

      const unarchived = await request(server).post(`${base()}/${id}/unarchive`).set(as(owner));
      expect(unarchived.body.status).toBe('PUBLISHED');
      expect(await routes(id)).toEqual([
        expect.objectContaining({ workflowVersionId: v2.id, resourceKey: 'owner/other' }),
      ]);
    });

    it('a manual trigger creates no routing rows', async () => {
      const id = await workflowWithDraft();
      await publish(id, 1).expect(201);
      expect(await routes(id)).toEqual([]);
    });
  });
});
