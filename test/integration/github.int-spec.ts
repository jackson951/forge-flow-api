import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule } from '@nestjs/testing';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import request, { Response } from 'supertest';
import { App } from 'supertest/types';
import { AppConfigService } from '../../src/config/app-config.service';
import { Env } from '../../src/config/env.schema';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RunQueue } from '../../src/infrastructure/queue/run-queue.service';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { createTestApp } from '../support/create-app';
import { createTestWorker, waitFor } from '../support/create-worker';
import { FakeGitHub } from '../support/fake-github';
import { issuesOpenedPayload } from '../support/github-fixtures';
import { truncateAll } from '../support/test-database';
import { TestNodeControl } from '../support/test-node-types';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const fake = new FakeGitHub(keys.publicKey);

const SECRETS = {
  GITHUB_CLIENT_SECRET: 'client-secret-must-never-leak',
  GITHUB_WEBHOOK_SECRET: 'webhook-secret-must-never-leak',
};

/** The app's GitHub settings point at the fake server. */
class GitHubTestConfig extends AppConfigService {
  override get<K extends keyof Env>(key: K): Env[K] {
    const overrides: Partial<Record<keyof Env, string>> = {
      GITHUB_APP_ID: '4242',
      GITHUB_APP_SLUG: 'flowforge-test',
      GITHUB_APP_PRIVATE_KEY: Buffer.from(keys.privateKey).toString('base64'),
      GITHUB_CLIENT_ID: 'Iv1.test',
      ...SECRETS,
      GITHUB_API_URL: fake.url,
      GITHUB_WEB_URL: fake.url,
      FRONTEND_URL: 'http://frontend.test',
    };
    return (overrides[key] ?? super.get(key)) as Env[K];
  }
}

describe('GitHub integration (integration)', () => {
  let api: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let worker: TestingModule;
  let admin: RegisteredUser;
  let ws: string;
  let connectionId: string;
  const responses: string[] = [];

  const track = (res: Response) => {
    responses.push(JSON.stringify(res.headers) + res.text);
    return res;
  };
  const asAdmin = () => bearer(admin.accessToken);
  const integrations = () => `/api/v1/workspaces/${ws}/integrations`;

  async function connect(installationId = 123, code = 'good-code'): Promise<URL> {
    const start = track(
      await request(server).post(`${integrations()}/GITHUB/connect`).set(asAdmin()),
    );
    expect(start.status).toBe(201);
    const state = new URL(start.body.url).searchParams.get('state')!;
    const callback = track(
      await request(server)
        .get('/api/v1/integrations/github/callback')
        .query({
          code,
          installation_id: String(installationId),
          setup_action: 'install',
          state,
        }),
    );
    expect(callback.status).toBe(302);
    return new URL(callback.headers.location);
  }

  function webhook(
    event: string,
    body: object,
    deliveryId = randomUUID(),
    secret = SECRETS.GITHUB_WEBHOOK_SECRET,
  ) {
    const raw = JSON.stringify(body);
    return request(server)
      .post('/api/v1/webhooks/github')
      .set({
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
      })
      .send(raw)
      .then(track);
  }

  async function publishIssueWorkflow(connection: string, repository = 'Octo-Org/Hello-World') {
    const base = `/api/v1/workspaces/${ws}/workflows`;
    const wf = await request(server).post(base).set(asAdmin()).send({ name: 'Triage' });
    await request(server)
      .put(`${base}/${wf.body.id}/draft`)
      .set(asAdmin())
      .send({
        expectedRevision: 0,
        definition: {
          schemaVersion: 1,
          nodes: [
            {
              key: 'issue',
              kind: 'TRIGGER',
              type: 'github.issue.created',
              config: { connectionId: connection, repository },
            },
            {
              key: 'isProd',
              kind: 'CONDITION',
              type: 'condition',
              config: {
                all: [
                  {
                    left: { ref: 'trigger.issue.labels' },
                    operator: 'contains',
                    right: { value: 'production' },
                  },
                ],
              },
            },
            {
              key: 'alert',
              kind: 'ACTION',
              type: 'util.log',
              config: {
                message: 'Prod issue #{{ trigger.issue.number }}: {{ trigger.issue.title }}',
              },
            },
          ],
          edges: [
            { from: 'issue', to: 'isProd' },
            { from: 'isProd', to: 'alert', branch: 'true' },
          ],
        },
      })
      .expect(200);
    const published = await request(server)
      .post(`${base}/${wf.body.id}/publish`)
      .set(asAdmin())
      .send({ expectedRevision: 1 })
      .then(track);
    return { workflowId: wf.body.id as string, published };
  }

  beforeAll(async () => {
    await fake.start();
    api = await createTestApp((b) =>
      b.overrideProvider(AppConfigService).useClass(GitHubTestConfig),
    );
    server = api.getHttpServer();
    prisma = api.get(PrismaService);
    worker = await createTestWorker(new TestNodeControl());
    await truncateAll(prisma);
    admin = await registerUser(server);
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: admin.id } }))
      .workspaceId;
  });

  afterAll(async () => {
    const all = responses.join('\n');
    // AC-10.4 (responses): no GitHub secrets or tokens ever leave the API.
    for (const secret of [
      ...Object.values(SECRETS),
      'ghu_',
      'ghs_',
      'PRIVATE KEY',
      keys.privateKey.slice(40, 80),
    ]) {
      expect(all).not.toContain(secret);
    }
    await worker.close();
    await api.get(RunQueue).queue.obliterate({ force: true });
    await api.close();
    await fake.stop();
  });

  describe('connect flow', () => {
    it('reports GitHub as configured', async () => {
      const res = await request(server).get('/api/v1/integrations/providers').set(asAdmin());
      expect(res.body).toEqual(expect.arrayContaining([{ key: 'GITHUB', configured: true }]));
    });

    it('starts at the app install page with a single-use state stored only as a hash', async () => {
      const res = track(
        await request(server).post(`${integrations()}/GITHUB/connect`).set(asAdmin()),
      );
      const url = new URL(res.body.url);
      expect(`${url.origin}${url.pathname}`).toBe(
        `${fake.url}/apps/flowforge-test/installations/new`,
      );
      const state = url.searchParams.get('state')!;
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const rows = await prisma.oAuthState.findMany({ where: { workspaceId: ws } });
      expect(JSON.stringify(rows)).not.toContain(state);
    });

    it('MEMBER cannot connect', async () => {
      const member = await registerUser(server);
      await request(server)
        .post(`/api/v1/workspaces/${ws}/members`)
        .set(asAdmin())
        .send({ email: member.email })
        .expect(201);
      await request(server)
        .post(`${integrations()}/GITHUB/connect`)
        .set(bearer(member.accessToken))
        .expect(403);
    });

    it('completes the installation and stores no tokens', async () => {
      const redirect = await connect();
      expect(redirect.origin).toBe('http://frontend.test');
      expect(Object.fromEntries(redirect.searchParams)).toEqual({
        provider: 'github',
        status: 'connected',
        connectionId: expect.any(String),
      });
      connectionId = redirect.searchParams.get('connectionId')!;

      const connection = await prisma.integrationConnection.findUniqueOrThrow({
        where: { id: connectionId },
      });
      expect(connection).toMatchObject({
        workspaceId: ws,
        provider: 'GITHUB',
        status: 'CONNECTED',
        externalAccountId: '123',
        accountLabel: 'Octo-Org',
        createdById: admin.id,
      });
      expect(await prisma.integrationCredential.count()).toBe(0);
      expect(fake.calls).toEqual(
        expect.arrayContaining([
          'POST /login/oauth/access_token',
          'GET /user/installations',
          'GET /app/installations/123',
        ]),
      );

      const list = track(await request(server).get(integrations()).set(asAdmin()));
      expect(list.body).toEqual([
        expect.objectContaining({ id: connectionId, provider: 'GITHUB', accountLabel: 'Octo-Org' }),
      ]);
    });

    it('reconnecting the same installation updates the existing connection', async () => {
      await connect();
      expect(await prisma.integrationConnection.count({ where: { workspaceId: ws } })).toBe(1);
    });

    it.each([
      ['an installation the user cannot access', 555, 'good-code', 'not_authorized'],
      ['a rejected authorization code', 123, 'bad-code', 'provider_error'],
    ])('refuses %s', async (_label, installationId, code, reason) => {
      fake.installations.set(555, { login: 'someone-else', type: 'User' });
      const before = await prisma.integrationConnection.count();
      const redirect = await connect(installationId, code);
      expect(Object.fromEntries(redirect.searchParams)).toMatchObject({ status: 'error', reason });
      expect(await prisma.integrationConnection.count()).toBe(before);
    });

    it('rejects reused, unknown and expired state', async () => {
      const start = await request(server).post(`${integrations()}/GITHUB/connect`).set(asAdmin());
      const state = new URL(start.body.url).searchParams.get('state')!;
      const call = (s: string) =>
        request(server)
          .get('/api/v1/integrations/github/callback')
          .query({ code: 'good-code', installation_id: '123', state: s });

      expect((await call(state)).headers.location).toContain('status=connected');
      expect((await call(state)).headers.location).toContain('reason=invalid_state');
      expect((await call('made-up-state')).headers.location).toContain('reason=invalid_state');

      const fresh = await request(server).post(`${integrations()}/GITHUB/connect`).set(asAdmin());
      const freshState = new URL(fresh.body.url).searchParams.get('state')!;
      await prisma.oAuthState.updateMany({
        where: { consumedAt: null },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      expect((await call(freshState)).headers.location).toContain('reason=invalid_state');
    });
  });

  describe('repositories', () => {
    const repos = () =>
      request(server)
        .get(`${integrations()}/${connectionId}/github/repositories`)
        .set(asAdmin())
        .then(track);

    it('lists repositories through a short-lived installation token', async () => {
      const res = await repos();
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ fullName: 'Octo-Org/Hello-World', private: false }]);
      expect(fake.calls).toContain('POST /app/installations/123/access_tokens');
    });

    it("another workspace's connection id is not found", async () => {
      const other = await registerUser(server);
      const otherWs = (
        await prisma.workspaceMember.findFirstOrThrow({ where: { userId: other.id } })
      ).workspaceId;
      await request(server)
        .get(`/api/v1/workspaces/${otherWs}/integrations/${connectionId}/github/repositories`)
        .set(bearer(other.accessToken))
        .expect(404);
    });

    it('a rate limit is a 503 and leaves the connection alone', async () => {
      fake.repositoriesStatus = 429;
      expect((await repos()).status).toBe(503);
      expect(
        (await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } }))
          .status,
      ).toBe('CONNECTED');
    });

    it('revoked access marks the connection NEEDS_ATTENTION (AC-10.5)', async () => {
      fake.repositoriesStatus = 401;
      expect((await repos()).status).toBe(409);
      expect(
        (await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } }))
          .status,
      ).toBe('NEEDS_ATTENTION');
      fake.repositoriesStatus = 200;
      await connect(); // reconnecting restores it
      expect(
        (await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } }))
          .status,
      ).toBe('CONNECTED');
    });
  });

  describe('trigger: GitHub issue created', () => {
    let workflowId: string;
    const runs = () => prisma.workflowRun.findMany({ where: { workflowId } });

    it('publishing binds the trigger to this connection and repository', async () => {
      const result = await publishIssueWorkflow(connectionId);
      expect(result.published.status).toBe(201);
      workflowId = result.workflowId;
      expect(await prisma.workflowTrigger.findMany({ where: { workflowId } })).toEqual([
        expect.objectContaining({
          provider: 'GITHUB',
          eventType: 'issues.opened',
          resourceKey: 'octo-org/hello-world',
          connectionId,
        }),
      ]);
    });

    it("refuses to publish with another workspace's connection id (tenant isolation)", async () => {
      const other = await registerUser(server);
      const otherWs = (
        await prisma.workspaceMember.findFirstOrThrow({ where: { userId: other.id } })
      ).workspaceId;
      const foreign = await prisma.integrationConnection.create({
        data: { workspaceId: otherWs, provider: 'GITHUB', externalAccountId: '777', scopes: [] },
      });
      const { published } = await publishIssueWorkflow(foreign.id);
      expect(published.status).toBe(422);
      expect(published.body.details).toEqual([
        expect.objectContaining({ code: 'CONNECTION_INVALID', nodeKey: 'issue' }),
      ]);
    });

    it('a signed issues.opened event runs the workflow end to end (AC-10.1 with a simulated GitHub)', async () => {
      const res = await webhook('issues', issuesOpenedPayload(123, 'Octo-Org/Hello-World'));
      expect(res.status).toBe(202);
      expect(res.body.runs).toBe(1);

      const [run] = await runs();
      const done = await waitFor(async () => {
        const r = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
        return r.status === 'SUCCEEDED' ? r : undefined;
      });
      expect(done.triggerSource).toBe('WEBHOOK');
      const alert = await prisma.stepRun.findFirstOrThrow({
        where: { runId: run.id, nodeKey: 'alert' },
      });
      expect(alert).toMatchObject({
        status: 'SUCCEEDED',
        sanitizedOutput: { message: 'Prod issue #42: Login page crashes' },
      });
    });

    it('rejects an invalid signature (AC-10.2)', async () => {
      expect(
        (await webhook('issues', issuesOpenedPayload(), randomUUID(), 'not-the-secret')).status,
      ).toBe(401);
    });

    it('a duplicate X-GitHub-Delivery does not create another run (AC-10.3)', async () => {
      const before = (await runs()).length;
      const delivery = randomUUID();
      expect((await webhook('issues', issuesOpenedPayload(), delivery)).body.runs).toBe(1);
      expect((await webhook('issues', issuesOpenedPayload(), delivery)).body).toMatchObject({
        duplicate: true,
      });
      expect(await runs()).toHaveLength(before + 1);
    });

    it('the same repository name from a different installation does not trigger', async () => {
      expect(
        (await webhook('issues', issuesOpenedPayload(999, 'Octo-Org/Hello-World'))).body.runs,
      ).toBe(0);
    });

    it('other repositories and other issue actions do not trigger', async () => {
      expect((await webhook('issues', issuesOpenedPayload(123, 'Octo-Org/Other'))).body.runs).toBe(
        0,
      );
      expect(
        (await webhook('issues', { ...issuesOpenedPayload(), action: 'edited' })).body.runs,
      ).toBe(0);
    });

    it('uninstalling the app disconnects the connection and stops triggering (AC-10.5)', async () => {
      const res = await webhook('installation', { action: 'deleted', installation: { id: 123 } });
      expect(res.status).toBe(202);
      expect(
        (await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } }))
          .status,
      ).toBe('DISCONNECTED');
      expect((await webhook('issues', issuesOpenedPayload())).body.runs).toBe(0);
    });
  });
});
