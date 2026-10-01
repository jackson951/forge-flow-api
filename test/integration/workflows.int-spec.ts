import { NestExpressApplication } from '@nestjs/platform-express';
import request, { Response } from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { createTestApp } from '../support/create-app';
import { createRun, createVersion } from '../support/factories';
import { truncateAll } from '../support/test-database';

const validDefinition = {
  schemaVersion: 1,
  nodes: [
    {
      key: 'trigger',
      kind: 'TRIGGER',
      type: 'manual.trigger',
      config: {},
      position: { x: 0, y: 0 },
    },
    {
      key: 'isHigh',
      kind: 'CONDITION',
      type: 'condition',
      config: {
        all: [{ left: { ref: 'trigger.priority' }, operator: 'equals', right: { value: 'HIGH' } }],
      },
    },
    { key: 'notify', kind: 'ACTION', type: 'util.log', config: { message: 'High priority!' } },
  ],
  edges: [
    { from: 'trigger', to: 'isHigh' },
    { from: 'isHigh', to: 'notify', branch: 'true' },
  ],
};

describe('Workflow management (integration)', () => {
  let app: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let owner: RegisteredUser;
  let member: RegisteredUser;
  let ws: string;

  const api = (user: RegisteredUser) => {
    const base = `/api/v1/workspaces/${ws}/workflows`;
    const auth = bearer(user.accessToken);
    return {
      list: (query = '') => request(server).get(`${base}${query}`).set(auth),
      get: (id: string) => request(server).get(`${base}/${id}`).set(auth),
      create: (body: object) => request(server).post(base).set(auth).send(body),
      update: (id: string, body: object) =>
        request(server).patch(`${base}/${id}`).set(auth).send(body),
      saveDraft: (id: string, body: object) =>
        request(server).put(`${base}/${id}/draft`).set(auth).send(body),
      validate: (id: string, body: object = {}) =>
        request(server).post(`${base}/${id}/validate`).set(auth).send(body),
      duplicate: (id: string) => request(server).post(`${base}/${id}/duplicate`).set(auth),
      archive: (id: string) => request(server).post(`${base}/${id}/archive`).set(auth),
      unarchive: (id: string) => request(server).post(`${base}/${id}/unarchive`).set(auth),
      remove: (id: string) => request(server).delete(`${base}/${id}`).set(auth),
    };
  };

  const createWorkflow = async (name = 'Triage issues') =>
    (await api(owner).create({ name }).expect(201)).body as { id: string; draftRevision: number };

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
    await truncateAll(prisma);

    owner = await registerUser(server);
    member = await registerUser(server);
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: owner.id } }))
      .workspaceId;
    await request(server)
      .post(`/api/v1/workspaces/${ws}/members`)
      .set(bearer(owner.accessToken))
      .send({ email: member.email, role: 'MEMBER' })
      .expect(201);
  });

  afterAll(() => app.close());

  describe('create / get / update', () => {
    it('creates a DRAFT workflow with an empty draft', async () => {
      const res = await api(member).create({ name: '  Triage  ', description: 'GitHub → Slack' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: 'Triage',
        description: 'GitHub → Slack',
        status: 'DRAFT',
        draftRevision: 0,
        activeVersion: null,
        draftDefinition: { schemaVersion: 1, nodes: [], edges: [] },
        issues: [expect.objectContaining({ code: 'NO_TRIGGER' })],
      });
      const row = await prisma.workflow.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row).toMatchObject({ workspaceId: ws, createdById: member.id });
    });

    it('validates metadata', async () => {
      await api(owner).create({ name: '' }).expect(400);
      await api(owner)
        .create({ name: 'x'.repeat(121) })
        .expect(400);
      await api(owner).create({ name: 'ok', status: 'PUBLISHED' }).expect(400);
    });

    it('updates metadata only', async () => {
      const wf = await createWorkflow();
      const res = await api(member).update(wf.id, { name: 'Renamed', description: 'new' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: 'Renamed', description: 'new', status: 'DRAFT' });
      await api(member).update(wf.id, { draftDefinition: {} }).expect(400);
    });

    it('returns 404 for an unknown workflow id', async () => {
      await api(owner).get('00000000-0000-4000-8000-000000000000').expect(404);
      await api(owner).get('not-a-uuid').expect(400);
    });
  });

  describe('drafts (AC-05.1, AC-05.2, AC-05.4)', () => {
    it('saves a valid workflow with no issues and bumps the revision', async () => {
      const wf = await createWorkflow();
      const res = await api(member).saveDraft(wf.id, {
        expectedRevision: 0,
        definition: validDefinition,
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ draftRevision: 1, issues: [] });

      const fetched = await api(member).get(wf.id).expect(200);
      expect(fetched.body.draftDefinition).toEqual(validDefinition);
      expect(fetched.body.draftRevision).toBe(1);
      expect(fetched.body.issues).toEqual([]);
    });

    it('rejects a structurally malformed definition with field details (400)', async () => {
      const wf = await createWorkflow();
      const res = await api(owner).saveDraft(wf.id, {
        expectedRevision: 0,
        definition: { schemaVersion: 1, nodes: [{ key: '9x', kind: 'LOOP' }], edges: 'nope' },
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Invalid workflow definition');
      expect(res.body.details.map((d: { field: string }) => d.field)).toEqual(
        expect.arrayContaining(['nodes.0.key', 'nodes.0.kind', 'nodes.0.type', 'edges']),
      );
      expect(
        (await prisma.workflow.findUniqueOrThrow({ where: { id: wf.id } })).draftRevision,
      ).toBe(0);
    });

    it('saves a semantically incomplete draft but reports the issues', async () => {
      const wf = await createWorkflow();
      const res = await api(owner).saveDraft(wf.id, {
        expectedRevision: 0,
        definition: {
          schemaVersion: 1,
          nodes: [{ key: 'orphan', kind: 'ACTION', type: 'util.log', config: { message: 'x' } }],
          edges: [{ from: 'orphan', to: 'ghost' }],
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.issues.map((i: { code: string }) => i.code)).toEqual(
        expect.arrayContaining(['NO_TRIGGER', 'EDGE_UNKNOWN_NODE']),
      );
    });

    it('rejects a stale revision with 409 and the current revision', async () => {
      const wf = await createWorkflow();
      await api(owner)
        .saveDraft(wf.id, { expectedRevision: 0, definition: validDefinition })
        .expect(200);
      const stale = await api(member).saveDraft(wf.id, {
        expectedRevision: 0,
        definition: validDefinition,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.details).toEqual({ currentRevision: 1 });
    });

    it('lets exactly one of two concurrent saves with the same revision win', async () => {
      const wf = await createWorkflow();
      const results = await Promise.all([
        api(owner).saveDraft(wf.id, { expectedRevision: 0, definition: validDefinition }),
        api(member).saveDraft(wf.id, { expectedRevision: 0, definition: validDefinition }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(
        (await prisma.workflow.findUniqueOrThrow({ where: { id: wf.id } })).draftRevision,
      ).toBe(1);
    });

    it('rejects drafts over the size limits', async () => {
      const wf = await createWorkflow();
      const nodes = [
        { key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger', config: {} },
        ...Array.from({ length: 51 }, (_, i) => ({
          key: `n${i}`,
          kind: 'ACTION',
          type: 'util.log',
          config: { message: 'x' },
        })),
      ];
      const res = await api(owner).saveDraft(wf.id, {
        expectedRevision: 0,
        definition: { schemaVersion: 1, nodes, edges: [] },
      });
      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([expect.objectContaining({ code: 'LIMIT_EXCEEDED' })]);
    });

    it('rejects request bodies over the JSON limit with 413', async () => {
      const wf = await createWorkflow();
      const res = await api(owner).saveDraft(wf.id, {
        expectedRevision: 0,
        definition: { schemaVersion: 1, nodes: [], edges: [], pad: 'x'.repeat(400_000) },
      });
      expect(res.status).toBe(413);
    });

    it('rejects secrets in node configuration', async () => {
      const wf = await createWorkflow();
      const definition = structuredClone(validDefinition);
      (definition.nodes[2].config as Record<string, unknown>).apiKey = 'sk-live-123';
      const res = await api(owner).saveDraft(wf.id, { expectedRevision: 0, definition });
      expect(res.status).toBe(200);
      // Also INVALID_NODE_CONFIG, because util.log has no such field; the secret rule is what matters.
      expect(res.body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'SECRET_IN_CONFIG', nodeKey: 'notify', path: 'apiKey' }),
        ]),
      );
    });
  });

  describe('validate', () => {
    it('validates a supplied definition without saving it', async () => {
      const wf = await createWorkflow();
      const res = await api(member).validate(wf.id, {
        definition: { ...validDefinition, edges: [] },
      });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.issues.map((i: { code: string }) => i.code)).toEqual([
        'UNREACHABLE_NODE',
        'UNREACHABLE_NODE',
        'CONDITION_WITHOUT_BRANCH',
      ]);
      expect(
        (await prisma.workflow.findUniqueOrThrow({ where: { id: wf.id } })).draftRevision,
      ).toBe(0);
    });

    it('validates the stored draft by default', async () => {
      const wf = await createWorkflow();
      await api(owner).saveDraft(wf.id, { expectedRevision: 0, definition: validDefinition });
      expect((await api(member).validate(wf.id)).body).toEqual({ valid: true, issues: [] });
    });
  });

  describe('list', () => {
    it('paginates with a stable cursor and hides archived workflows by default', async () => {
      const fresh = await registerUser(server);
      const freshWs = (
        await prisma.workspaceMember.findFirstOrThrow({ where: { userId: fresh.id } })
      ).workspaceId;
      const base = `/api/v1/workspaces/${freshWs}/workflows`;
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await request(server)
          .post(base)
          .set(bearer(fresh.accessToken))
          .send({ name: `wf ${i}` })
          .expect(201);
        ids.push(res.body.id);
      }
      await request(server)
        .post(`${base}/${ids[0]}/archive`)
        .set(bearer(fresh.accessToken))
        .expect(200);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res: Response = await request(server)
          .get(`${base}?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
          .set(bearer(fresh.accessToken))
          .expect(200);
        expect(res.body.items.length).toBeLessThanOrEqual(2);
        expect(res.body.items[0]).not.toHaveProperty('draftDefinition');
        seen.push(...res.body.items.map((w: { id: string }) => w.id));
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(seen).toEqual([...ids.slice(1)].reverse());

      const all = await request(server)
        .get(`${base}?includeArchived=true&limit=100`)
        .set(bearer(fresh.accessToken));
      expect(all.body.items).toHaveLength(5);
      const archived = await request(server)
        .get(`${base}?status=ARCHIVED`)
        .set(bearer(fresh.accessToken));
      expect(archived.body.items.map((w: { id: string }) => w.id)).toEqual([ids[0]]);
    });

    it('rejects a bad cursor and an over-large limit', async () => {
      await api(owner).list('?cursor=garbage').expect(400);
      await api(owner).list('?limit=101').expect(400);
    });
  });

  describe('duplicate / archive / delete', () => {
    it('duplicates into an independent draft (AC-05.8)', async () => {
      const wf = await createWorkflow('Original');
      await api(owner).saveDraft(wf.id, { expectedRevision: 0, definition: validDefinition });
      const copy = await api(member).duplicate(wf.id);
      expect(copy.status).toBe(201);
      expect(copy.body).toMatchObject({
        name: 'Copy of Original',
        status: 'DRAFT',
        draftRevision: 0,
      });

      await api(member).saveDraft(copy.body.id, {
        expectedRevision: 0,
        definition: { schemaVersion: 1, nodes: [], edges: [] },
      });
      expect((await api(owner).get(wf.id)).body.draftDefinition).toEqual(validDefinition);
    });

    it('archive blocks editing; unarchive restores DRAFT', async () => {
      const wf = await createWorkflow();
      expect((await api(owner).archive(wf.id)).body.status).toBe('ARCHIVED');
      const blocked = await api(owner).saveDraft(wf.id, {
        expectedRevision: 0,
        definition: validDefinition,
      });
      expect(blocked.status).toBe(409);
      expect(blocked.body.message).toMatch(/Archived/);
      expect((await api(owner).unarchive(wf.id)).body.status).toBe('DRAFT');
      await api(owner)
        .saveDraft(wf.id, { expectedRevision: 0, definition: validDefinition })
        .expect(200);
    });

    it('MEMBER cannot archive, unarchive or delete (AC-05.5)', async () => {
      const wf = await createWorkflow();
      await api(member).archive(wf.id).expect(403);
      await api(member).unarchive(wf.id).expect(403);
      await api(member).remove(wf.id).expect(403);
    });

    it('deletes a workflow without runs (204) but not one with runs (409) (AC-05.7)', async () => {
      const disposable = await createWorkflow();
      await api(owner).remove(disposable.id).expect(204);
      await api(owner).get(disposable.id).expect(404);

      const used = await createWorkflow();
      const version = await createVersion(prisma, { id: used.id, workspaceId: ws });
      await createRun(prisma, version);
      const res = await api(owner).remove(used.id);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/archive it instead/);
      await api(owner).get(used.id).expect(200);
    });

    it('publishing and version history are not implemented yet, but still scoped', async () => {
      const wf = await createWorkflow();
      await request(server)
        .post(`/api/v1/workspaces/${ws}/workflows/${wf.id}/publish`)
        .set(bearer(owner.accessToken))
        .expect(501);
    });
  });

  describe('node types', () => {
    it('lists the built-in catalog', async () => {
      const res = await request(server).get('/api/v1/node-types').set(bearer(member.accessToken));
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.arrayContaining([
          { type: 'manual.trigger', kind: 'TRIGGER', displayName: 'Manual trigger' },
          { type: 'condition', kind: 'CONDITION', displayName: 'Condition' },
          { type: 'util.log', kind: 'ACTION', displayName: 'Log message' },
        ]),
      );
    });
  });
});
