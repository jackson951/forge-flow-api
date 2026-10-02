import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { NodeTypeCatalog } from '../../src/engine/catalog/node-type-catalog';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RunQueue } from '../../src/infrastructure/queue/run-queue.service';
import { TEST_PASSWORD, uniqueEmail } from '../support/auth';
import { captureLogs, expectNoSecrets } from '../support/canaries';
import { createTestApp } from '../support/create-app';
import { createTestWorker, waitFor } from '../support/create-worker';
import { truncateAll } from '../support/test-database';
import { registerTestTypes, TestNodeControl } from '../support/test-node-types';

const SECRET = process.env.WEBHOOK_TEST_SECRET!;

/** Signs like a provider: HMAC over "<timestamp>.<raw body>" (TEST provider, Part 09). */
function signedWebhook(server: App, body: object, deliveryId = randomUUID(), secret = SECRET) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  return request(server)
    .post('/api/v1/webhooks/test')
    .set({
      'content-type': 'application/json',
      'x-flowforge-delivery': deliveryId,
      'x-flowforge-event': 'issue.created',
      'x-flowforge-timestamp': String(ts),
      'x-flowforge-signature': `sha256=${signature}`,
    })
    .send(raw);
}

/**
 * Part 19 — the user journey end to end, through HTTP only, with the API and the worker
 * running in-process against Postgres and Redis.
 */
describe('User journey (e2e)', () => {
  let api: NestExpressApplication;
  let server: App;
  let worker: TestingModule;
  let prisma: PrismaService;
  const logged: unknown[][] = [];

  let token: string;
  let workspaceId: string;
  let workflowId: string;
  let runId: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  const settledRun = (workflow: string) =>
    waitFor(
      async () => {
        const res = await request(server)
          .get(`/api/v1/workspaces/${workspaceId}/runs`)
          .query({ workflowId: workflow })
          .set(auth());
        const run = res.body.items?.[0];
        return run && ['SUCCEEDED', 'FAILED'].includes(run.status) ? run : undefined;
      },
      { what: 'the run to finish' },
    );

  async function publishWorkflow(name: string, definition: object): Promise<string> {
    const created = await request(server)
      .post(`/api/v1/workspaces/${workspaceId}/workflows`)
      .set(auth())
      .send({ name })
      .expect(201);
    const draft = await request(server)
      .put(`/api/v1/workspaces/${workspaceId}/workflows/${created.body.id}/draft`)
      .set(auth())
      .send({ expectedRevision: 0, definition })
      .expect(200);
    expect(draft.body.issues).toEqual([]);
    await request(server)
      .post(`/api/v1/workspaces/${workspaceId}/workflows/${created.body.id}/publish`)
      .set(auth())
      .send({ expectedRevision: 1 })
      .expect(201);
    return created.body.id;
  }

  beforeAll(async () => {
    captureLogs(logged);
    api = await createTestApp();
    server = api.getHttpServer();
    prisma = api.get(PrismaService);
    registerTestTypes(api.get(NodeTypeCatalog));
    worker = await createTestWorker(new TestNodeControl());
    await truncateAll(prisma);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await worker?.close();
    await api.get(RunQueue).queue.obliterate({ force: true });
    await api.close();
  });

  describe('happy path', () => {
    const email = uniqueEmail('journey');

    it('register → login', async () => {
      await request(server)
        .post('/api/v1/auth/register')
        .send({ email, password: TEST_PASSWORD, name: 'Journey' })
        .expect(201);
      const login = await request(server)
        .post('/api/v1/auth/login')
        .send({ email, password: TEST_PASSWORD })
        .expect(200);
      token = login.body.accessToken;
      expect(token).toEqual(expect.any(String));
    });

    it('create a workspace', async () => {
      const res = await request(server)
        .post('/api/v1/workspaces')
        .set(auth())
        .send({ name: 'Journey Inc' })
        .expect(201);
      workspaceId = res.body.id;
    });

    it('create, draft and publish a webhook workflow (trigger → condition → log)', async () => {
      workflowId = await publishWorkflow('Triage', {
        schemaVersion: 1,
        nodes: [
          {
            key: 'hook',
            kind: 'TRIGGER',
            type: 'test.event',
            config: { event: 'issue.created', resource: 'journey-repo' },
          },
          {
            key: 'isHigh',
            kind: 'CONDITION',
            type: 'condition',
            config: {
              all: [
                { left: { ref: 'trigger.priority' }, operator: 'equals', right: { value: 'HIGH' } },
              ],
            },
          },
          {
            key: 'alert',
            kind: 'ACTION',
            type: 'util.log',
            config: { message: 'High priority: {{ trigger.title }}' },
          },
          { key: 'ignore', kind: 'ACTION', type: 'util.log', config: { message: 'Low priority' } },
        ],
        edges: [
          { from: 'hook', to: 'isHigh' },
          { from: 'isHigh', to: 'alert', branch: 'true' },
          { from: 'isHigh', to: 'ignore', branch: 'false' },
        ],
      });
    });

    it('a signed webhook queues a run that the worker executes on the right branch', async () => {
      const delivery = await signedWebhook(server, {
        resource: 'journey-repo',
        data: { title: 'Checkout is down', priority: 'HIGH' },
      });
      expect(delivery.status).toBe(202);
      expect(delivery.body).toMatchObject({ accepted: true, duplicate: false, runs: 1 });

      const run = await settledRun(workflowId);
      runId = run.id;
      expect(run).toMatchObject({ status: 'SUCCEEDED', triggerSource: 'WEBHOOK', version: 1 });

      const detail = await request(server)
        .get(`/api/v1/workspaces/${workspaceId}/runs/${runId}`)
        .set(auth())
        .expect(200);
      expect(detail.body).toMatchObject({
        status: 'SUCCEEDED',
        error: null,
        failedStep: null,
        triggerInput: { title: 'Checkout is down', priority: 'HIGH' },
      });

      const steps = await request(server)
        .get(`/api/v1/workspaces/${workspaceId}/runs/${runId}/steps`)
        .set(auth())
        .expect(200);
      expect(
        steps.body.map((s: { nodeKey: string; status: string }) => [s.nodeKey, s.status]),
      ).toEqual([
        ['hook', 'SUCCEEDED'],
        ['isHigh', 'SUCCEEDED'],
        ['alert', 'SUCCEEDED'],
        ['ignore', 'SKIPPED'],
      ]);
      expect(steps.body[2].output).toEqual({ message: 'High priority: Checkout is down' });
    });
  });

  describe('failure paths', () => {
    it('an invalid signature is rejected and starts nothing', async () => {
      const before = await prisma.workflowRun.count();
      const res = await signedWebhook(
        server,
        { resource: 'journey-repo', data: { priority: 'HIGH' } },
        randomUUID(),
        'not-the-shared-secret-at-all',
      );
      expect(res.status).toBe(401);
      expect(await prisma.workflowRun.count()).toBe(before);
    });

    it('a duplicate delivery is acknowledged without a second run', async () => {
      const deliveryId = randomUUID();
      const body = { resource: 'journey-repo', data: { priority: 'LOW' } };
      expect((await signedWebhook(server, body, deliveryId)).status).toBe(202);
      const again = await signedWebhook(server, body, deliveryId);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ duplicate: true });
      expect(await prisma.workflowRun.count({ where: { workflowId } })).toBe(2);
    });

    it('a failing node fails the run with a category visible through the API', async () => {
      const failing = await publishWorkflow('Fails', {
        schemaVersion: 1,
        nodes: [
          {
            key: 'hook',
            kind: 'TRIGGER',
            type: 'test.event',
            config: { event: 'issue.created', resource: 'failing-repo' },
          },
          { key: 'boom', kind: 'ACTION', type: 'test.fail', config: { mode: 'permanent' } },
        ],
        edges: [{ from: 'hook', to: 'boom' }],
      });
      expect((await signedWebhook(server, { resource: 'failing-repo', data: {} })).status).toBe(
        202,
      );
      const run = await settledRun(failing);
      expect(run).toMatchObject({
        status: 'FAILED',
        error: { category: 'PERMANENT_PROVIDER_ERROR', retryable: false },
      });
      const detail = await request(server)
        .get(`/api/v1/workspaces/${workspaceId}/runs/${run.id}`)
        .set(auth());
      expect(detail.body.failedStep).toMatchObject({
        nodeKey: 'boom',
        error: { category: 'PERMANENT_PROVIDER_ERROR', message: 'provider rejected the request' },
      });
    });

    it("another user cannot see this workspace's run (404, as if it did not exist)", async () => {
      const outsiderEmail = uniqueEmail('outsider');
      await request(server)
        .post('/api/v1/auth/register')
        .send({ email: outsiderEmail, password: TEST_PASSWORD, name: 'Outsider' })
        .expect(201);
      const login = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: outsiderEmail, password: TEST_PASSWORD })
        .expect(200);
      const outsider = { Authorization: `Bearer ${login.body.accessToken}` };
      const own = await request(server).get('/api/v1/workspaces').set(outsider).expect(200);
      const outsiderWs = own.body[0].id;

      for (const path of [
        `/api/v1/workspaces/${workspaceId}/runs/${runId}`,
        `/api/v1/workspaces/${workspaceId}/runs/${runId}/steps`,
        `/api/v1/workspaces/${outsiderWs}/runs/${runId}`,
      ]) {
        const res = await request(server).get(path).set(outsider);
        expect([path, res.status]).toEqual([path, 404]);
      }
      const unknown = await request(server)
        .get(`/api/v1/workspaces/${outsiderWs}/runs/${randomUUID()}`)
        .set(outsider);
      const foreign = await request(server)
        .get(`/api/v1/workspaces/${outsiderWs}/runs/${runId}`)
        .set(outsider);
      expect(foreign.body.message).toBe(unknown.body.message);
    });

    it('no credential reached a log line during the journey', () => {
      expect(logged.length).toBeGreaterThan(0);
      expectNoSecrets(logged, [SECRET, TEST_PASSWORD, token]);
    });
  });
});
