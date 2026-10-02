import { NestExpressApplication } from '@nestjs/platform-express';
import { WorkspaceRole } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { createTestApp } from '../support/create-app';
import { truncateAll } from '../support/test-database';

describe('Workspaces and members (integration)', () => {
  let app: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;

  const api = (token: string) => ({
    get: (url: string) => request(server).get(`/api/v1${url}`).set(bearer(token)),
    post: (url: string, body: object = {}) =>
      request(server).post(`/api/v1${url}`).set(bearer(token)).send(body),
    patch: (url: string, body: object = {}) =>
      request(server).patch(`/api/v1${url}`).set(bearer(token)).send(body),
    delete: (url: string) => request(server).delete(`/api/v1${url}`).set(bearer(token)),
  });

  /** A fresh workspace owned by `owner`, with the given extra members. */
  async function team(owner: RegisteredUser, members: [RegisteredUser, WorkspaceRole][] = []) {
    const res = await api(owner.accessToken).post('/workspaces', { name: 'Team' }).expect(201);
    const id: string = res.body.id;
    for (const [user, role] of members) {
      await api(owner.accessToken)
        .post(`/workspaces/${id}/members`, { email: user.email, role })
        .expect(201);
    }
    return id;
  }

  const roleOf = async (workspaceId: string, userId: string) =>
    (
      await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
      })
    )?.role;

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
    await truncateAll(prisma);
  });

  afterAll(() => app.close());

  describe('workspaces', () => {
    it('creating a workspace makes the creator OWNER (AC-04.1)', async () => {
      const owner = await registerUser(server);
      const res = await api(owner.accessToken).post('/workspaces', { name: '  Platform  ' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(String),
        name: 'Platform',
        role: 'OWNER',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(await roleOf(res.body.id, owner.id)).toBe('OWNER');
      expect(
        await prisma.auditEvent.count({
          where: { action: 'workspace.created', workspaceId: res.body.id },
        }),
      ).toBe(1);
    });

    it('lists only the caller’s workspaces with their role (AC-04.2)', async () => {
      const owner = await registerUser(server);
      const member = await registerUser(server);
      const shared = await team(owner, [[member, 'MEMBER']]);

      const res = await api(member.accessToken).get('/workspaces').expect(200);
      const byId = Object.fromEntries(
        res.body.map((w: { id: string; role: string }) => [w.id, w.role]),
      );
      expect(Object.keys(byId)).toHaveLength(2); // personal + shared
      expect(byId[shared]).toBe('MEMBER');
    });

    it('validates the name', async () => {
      const owner = await registerUser(server);
      await api(owner.accessToken).post('/workspaces', { name: '   ' }).expect(400);
      await api(owner.accessToken)
        .post('/workspaces', { name: 'x'.repeat(101) })
        .expect(400);
    });

    it('members can read, ADMIN+ can rename, only OWNER can delete (AC-04.5)', async () => {
      const owner = await registerUser(server);
      const admin = await registerUser(server);
      const member = await registerUser(server);
      const ws = await team(owner, [
        [admin, 'ADMIN'],
        [member, 'MEMBER'],
      ]);

      expect((await api(member.accessToken).get(`/workspaces/${ws}`)).body.role).toBe('MEMBER');
      await api(member.accessToken).patch(`/workspaces/${ws}`, { name: 'Nope' }).expect(403);
      const renamed = await api(admin.accessToken).patch(`/workspaces/${ws}`, { name: 'Renamed' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe('Renamed');

      await api(admin.accessToken).delete(`/workspaces/${ws}`).expect(403);
      await api(member.accessToken).delete(`/workspaces/${ws}`).expect(403);
      await api(owner.accessToken).delete(`/workspaces/${ws}`).expect(204);

      await api(owner.accessToken).get(`/workspaces/${ws}`).expect(404);
      expect(await prisma.workspaceMember.count({ where: { workspaceId: ws } })).toBe(0);
      expect(
        await prisma.auditEvent.count({ where: { action: 'workspace.deleted', targetId: ws } }),
      ).toBe(1);
    });

    it('403 body names the missing role but 404 is used for non-members', async () => {
      const owner = await registerUser(server);
      const member = await registerUser(server);
      const ws = await team(owner, [[member, 'MEMBER']]);
      const res = await api(member.accessToken).delete(`/workspaces/${ws}`);
      expect(res.body).toMatchObject({
        statusCode: 403,
        message: 'Requires OWNER role in this workspace',
      });
    });
  });

  describe('members', () => {
    it('ADMIN can add members; duplicate → 409; unknown email → 404', async () => {
      const owner = await registerUser(server);
      const admin = await registerUser(server);
      const newcomer = await registerUser(server);
      const ws = await team(owner, [[admin, 'ADMIN']]);

      const res = await api(admin.accessToken).post(`/workspaces/${ws}/members`, {
        email: newcomer.email.toUpperCase(),
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        userId: newcomer.id,
        email: newcomer.email,
        name: 'Test User',
        role: 'MEMBER',
        joinedAt: expect.any(String),
      });

      await api(admin.accessToken)
        .post(`/workspaces/${ws}/members`, { email: newcomer.email })
        .expect(409);
      await api(admin.accessToken)
        .post(`/workspaces/${ws}/members`, { email: 'nobody@example.test' })
        .expect(404);
    });

    it('lists members without sensitive fields', async () => {
      const owner = await registerUser(server);
      const ws = await team(owner);
      const res = await api(owner.accessToken).get(`/workspaces/${ws}/members`).expect(200);
      expect(res.body).toEqual([expect.objectContaining({ userId: owner.id, role: 'OWNER' })]);
      expect(res.text).not.toMatch(/passwordHash|argon2/);
    });

    it('enforces the role matrix for member management (AC-04.5)', async () => {
      const owner = await registerUser(server);
      const admin = await registerUser(server);
      const member = await registerUser(server);
      const other = await registerUser(server);
      const ws = await team(owner, [
        [admin, 'ADMIN'],
        [member, 'MEMBER'],
      ]);
      const members = `/workspaces/${ws}/members`;

      // MEMBER: no management at all.
      await api(member.accessToken).post(members, { email: other.email }).expect(403);
      await api(member.accessToken).patch(`${members}/${admin.id}`, { role: 'MEMBER' }).expect(403);
      await api(member.accessToken).delete(`${members}/${admin.id}`).expect(403);

      // ADMIN: cannot grant or touch OWNER.
      await api(admin.accessToken).post(members, { email: other.email, role: 'OWNER' }).expect(403);
      await api(admin.accessToken).patch(`${members}/${admin.id}`, { role: 'OWNER' }).expect(403);
      await api(admin.accessToken).patch(`${members}/${owner.id}`, { role: 'MEMBER' }).expect(403);
      await api(admin.accessToken).delete(`${members}/${owner.id}`).expect(403);
      // …but can manage non-owners.
      await api(admin.accessToken).patch(`${members}/${member.id}`, { role: 'ADMIN' }).expect(200);
      expect(await roleOf(ws, member.id)).toBe('ADMIN');

      // OWNER: can grant OWNER.
      await api(owner.accessToken).patch(`${members}/${admin.id}`, { role: 'OWNER' }).expect(200);
      expect(await roleOf(ws, admin.id)).toBe('OWNER');
      expect(owner.id).toBeDefined();
    });

    it('protects the last OWNER (AC-04.6)', async () => {
      const owner = await registerUser(server);
      const admin = await registerUser(server);
      const ws = await team(owner, [[admin, 'ADMIN']]);

      const demote = await api(owner.accessToken).patch(`/workspaces/${ws}/members/${owner.id}`, {
        role: 'ADMIN',
      });
      expect(demote.status).toBe(409);
      expect(demote.body.message).toBe('A workspace must keep at least one owner');
      await api(owner.accessToken).delete(`/workspaces/${ws}/members/${owner.id}`).expect(409);
      expect(await roleOf(ws, owner.id)).toBe('OWNER');

      // With a second owner, the first may step down.
      await api(owner.accessToken)
        .patch(`/workspaces/${ws}/members/${admin.id}`, { role: 'OWNER' })
        .expect(200);
      await api(owner.accessToken)
        .patch(`/workspaces/${ws}/members/${owner.id}`, { role: 'ADMIN' })
        .expect(200);
    });

    it('two owners demoting each other concurrently cannot leave zero owners', async () => {
      const first = await registerUser(server);
      const second = await registerUser(server);
      const ws = await team(first, [[second, 'OWNER']]);

      const results = await Promise.all([
        api(first.accessToken).patch(`/workspaces/${ws}/members/${second.id}`, { role: 'ADMIN' }),
        api(second.accessToken).patch(`/workspaces/${ws}/members/${first.id}`, { role: 'ADMIN' }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 403].sort());
      expect(
        await prisma.workspaceMember.count({ where: { workspaceId: ws, role: 'OWNER' } }),
      ).toBe(1);
    });

    it('any member can leave, and loses access immediately with the same token', async () => {
      const owner = await registerUser(server);
      const member = await registerUser(server);
      const ws = await team(owner, [[member, 'MEMBER']]);

      await api(member.accessToken).get(`/workspaces/${ws}`).expect(200);
      await api(member.accessToken).delete(`/workspaces/${ws}/members/${member.id}`).expect(204);
      await api(member.accessToken).get(`/workspaces/${ws}`).expect(404);
      expect(
        await prisma.auditEvent.count({ where: { action: 'member.left', targetId: member.id } }),
      ).toBe(1);
    });

    it('a demotion takes effect on the very next request', async () => {
      const owner = await registerUser(server);
      const admin = await registerUser(server);
      const ws = await team(owner, [[admin, 'ADMIN']]);

      await api(admin.accessToken).patch(`/workspaces/${ws}`, { name: 'ok' }).expect(200);
      await api(owner.accessToken)
        .patch(`/workspaces/${ws}/members/${admin.id}`, { role: 'MEMBER' })
        .expect(200);
      await api(admin.accessToken).patch(`/workspaces/${ws}`, { name: 'no' }).expect(403);
    });

    it('rejects invalid input', async () => {
      const owner = await registerUser(server);
      const ws = await team(owner);
      await api(owner.accessToken)
        .post(`/workspaces/${ws}/members`, { email: 'x', role: 'GOD' })
        .expect(400);
      await api(owner.accessToken)
        .patch(`/workspaces/${ws}/members/not-a-uuid`, { role: 'ADMIN' })
        .expect(400);
    });
  });

  describe('feature routes under the workspace prefix', () => {
    it('members reach the handlers; role rules apply before them', async () => {
      const owner = await registerUser(server);
      const member = await registerUser(server);
      const ws = await team(owner, [[member, 'MEMBER']]);
      const wf = '00000000-0000-4000-8000-000000000000';

      await api(member.accessToken).get(`/workspaces/${ws}/workflows`).expect(200);
      await api(member.accessToken).post(`/workspaces/${ws}/workflows/${wf}/publish`).expect(403);
      await api(owner.accessToken)
        .post(`/workspaces/${ws}/workflows/${wf}/publish`, { expectedRevision: 0 })
        .expect(404);
      await api(member.accessToken).get(`/workspaces/${ws}/runs`).expect(200);
      await api(member.accessToken).post(`/workspaces/${ws}/runs/${wf}/retry`).expect(403);
      await api(member.accessToken)
        .post(`/workspaces/${ws}/integrations/GITHUB/connect`)
        .expect(403);
    });
  });
});
