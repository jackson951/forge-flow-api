import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { NodeTypeCatalog } from '../../src/engine/catalog/node-type-catalog';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RunQueue } from '../../src/infrastructure/queue/run-queue.service';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { createTestApp } from '../support/create-app';
import { createTestWorker, waitFor } from '../support/create-worker';
import { truncateAll } from '../support/test-database';
import { registerTestTypes, TestNodeControl } from '../support/test-node-types';

const SECRET = process.env.WEBHOOK_TEST_SECRET!;

/** Signs like a provider would: HMAC over "<timestamp>.<raw body>". */
function signed(
  body: object,
  opts: { deliveryId?: string; event?: string; timestamp?: number; secret?: string } = {},
) {
  const raw = JSON.stringify(body);
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', opts.secret ?? SECRET)
    .update(`${ts}.${raw}`)
    .digest('hex');
  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'x-flowforge-delivery': opts.deliveryId ?? randomUUID(),
      'x-flowforge-event': opts.event ?? 'issue.created',
      'x-flowforge-timestamp': String(ts),
      'x-flowforge-signature': `sha256=${sig}`,
    },
  };
}

describe('Webhook platform (integration)', () => {
  let api: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let worker: TestingModule;
  let user: RegisteredUser;
  let ws: string;

  const send = (msg: { raw: string; headers: Record<string, string> }) =>
    request(server).post('/api/v1/webhooks/test').set(msg.headers).send(msg.raw);

  async function publishWebhookWorkflow(
    resource: string,
    then: object = { message: 'got {{ trigger.title }}' },
  ) {
    const base = `/api/v1/workspaces/${ws}/workflows`;
    const wf = await request(server)
      .post(base)
      .set(bearer(user.accessToken))
      .send({ name: 'hook' });
    const draft = await request(server)
      .put(`${base}/${wf.body.id}/draft`)
      .set(bearer(user.accessToken))
      .send({
        expectedRevision: 0,
        definition: {
          schemaVersion: 1,
          nodes: [
            {
              key: 'hook',
              kind: 'TRIGGER',
              type: 'test.event',
              config: { event: 'issue.created', resource },
            },
            { key: 'log', kind: 'ACTION', type: 'util.log', config: then },
          ],
          edges: [{ from: 'hook', to: 'log' }],
        },
      });
    expect(draft.body.issues).toEqual([]);
    await request(server)
      .post(`${base}/${wf.body.id}/publish`)
      .set(bearer(user.accessToken))
      .send({ expectedRevision: 1 })
      .expect(201);
    return wf.body.id as string;
  }

  const runsFor = (workflowId: string) => prisma.workflowRun.findMany({ where: { workflowId } });

  beforeAll(async () => {
    api = await createTestApp();
    server = api.getHttpServer();
    prisma = api.get(PrismaService);
    registerTestTypes(api.get(NodeTypeCatalog));
    worker = await createTestWorker(new TestNodeControl());
    await truncateAll(prisma);
    user = await registerUser(server);
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: user.id } }))
      .workspaceId;
  });

  afterAll(async () => {
    await worker.close();
    await api.get(RunQueue).queue.obliterate({ force: true });
    await api.close();
  });

  it('accepts a valid webhook, creates a run and the worker executes it (AC-09.1, AC-09.6)', async () => {
    const workflowId = await publishWebhookWorkflow('repo-a');
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const msg = signed({ resource: 'repo-a', data: { title: 'Crash on login', number: 7 } });

    const started = Date.now();
    const res = await send(msg);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      accepted: true,
      duplicate: false,
      deliveryId: msg.headers['x-flowforge-delivery'],
      runs: 1,
    });
    expect(fetchSpy).not.toHaveBeenCalled(); // no outbound calls in the request path (AC-09.5)
    fetchSpy.mockRestore();
    expect(elapsed).toBeLessThan(1_000);

    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      where: { deliveryId: msg.headers['x-flowforge-delivery'] },
    });
    expect(delivery).toMatchObject({
      provider: 'TEST',
      status: 'PROCESSED',
      workspaceId: ws,
      eventType: 'issue.created',
    });
    expect(delivery.processedAt).not.toBeNull();

    const [run] = await runsFor(workflowId);
    expect(run).toMatchObject({
      triggerSource: 'WEBHOOK',
      webhookDeliveryId: delivery.id,
      triggerInput: { title: 'Crash on login', number: 7 },
      idempotencyKey: `TEST:${msg.headers['x-flowforge-delivery']}:${workflowId}`,
      correlationId: expect.any(String),
    });

    const done = await waitFor(async () => {
      const r = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
      return r.status === 'SUCCEEDED' ? r : undefined;
    });
    expect(done.status).toBe('SUCCEEDED');
    const log = await prisma.stepRun.findFirstOrThrow({ where: { runId: run.id, nodeKey: 'log' } });
    expect(log.sanitizedOutput).toEqual({ message: 'got Crash on login' });
  });

  describe('signature verification (AC-09.2)', () => {
    const body = { resource: 'repo-sig', data: {} };

    it.each([
      ['wrong secret', () => signed(body, { secret: 'not-the-real-webhook-secret' })],
      [
        'stale timestamp (replay window)',
        () => signed(body, { timestamp: Math.floor(Date.now() / 1000) - 3_600 }),
      ],
      [
        'tampered body',
        () => {
          const msg = signed(body);
          return { ...msg, raw: msg.raw.replace('repo-sig', 'repo-xxx') };
        },
      ],
    ])('rejects %s with 401 and writes nothing', async (_label, make) => {
      const before = await prisma.webhookDelivery.count();
      const res = await send(make());
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid webhook signature');
      expect(await prisma.webhookDelivery.count()).toBe(before);
    });

    it('rejects a missing delivery id with 400', async () => {
      const msg = signed(body);
      const headers: Record<string, string> = { ...msg.headers };
      delete headers['x-flowforge-delivery'];
      expect((await send({ raw: msg.raw, headers })).status).toBe(400);
    });

    it('unknown providers are 404', async () => {
      const msg = signed(body);
      await request(server)
        .post('/api/v1/webhooks/nope')
        .set(msg.headers)
        .send(msg.raw)
        .expect(404);
    });
  });

  describe('duplicates (AC-09.3, AC-09.4)', () => {
    it('a repeated delivery is acknowledged as duplicate and creates no second run', async () => {
      const workflowId = await publishWebhookWorkflow('repo-dup');
      const msg = signed({ resource: 'repo-dup', data: { n: 1 } });

      expect((await send(msg)).status).toBe(202);
      const second = await send(msg);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ duplicate: true });

      // Even re-signed later (provider redelivery), the same delivery id is a duplicate.
      const redelivery = signed(
        { resource: 'repo-dup', data: { n: 1 } },
        { deliveryId: msg.headers['x-flowforge-delivery'] },
      );
      expect((await send(redelivery)).body.duplicate).toBe(true);

      expect(await runsFor(workflowId)).toHaveLength(1);
    });

    it('10 concurrent copies of one delivery create exactly one delivery and one run', async () => {
      const workflowId = await publishWebhookWorkflow('repo-race');
      const msg = signed({ resource: 'repo-race', data: {} });
      const results = await Promise.all(Array.from({ length: 10 }, () => send(msg)));

      expect(results.filter((r) => r.status === 202)).toHaveLength(1);
      expect(results.filter((r) => r.status === 200)).toHaveLength(9);
      expect(
        await prisma.webhookDelivery.count({
          where: { deliveryId: msg.headers['x-flowforge-delivery'] },
        }),
      ).toBe(1);
      expect(await runsFor(workflowId)).toHaveLength(1);
    });
  });

  describe('routing', () => {
    it('one delivery starts every matching published workflow once', async () => {
      const first = await publishWebhookWorkflow('repo-shared');
      const second = await publishWebhookWorkflow('repo-shared');
      const res = await send(signed({ resource: 'repo-shared', data: {} }));
      expect(res.body.runs).toBe(2);
      expect(await runsFor(first)).toHaveLength(1);
      expect(await runsFor(second)).toHaveLength(1);
    });

    it('stores non-matching and unusable events as IGNORED', async () => {
      const noMatch = signed({ resource: 'nobody-listens', data: {} });
      const res = await send(noMatch);
      expect(res.status).toBe(202);
      expect(res.body.runs).toBe(0);

      const unusable = signed({ data: {} }); // no resource → normaliser ignores it
      expect((await send(unusable)).body.runs).toBe(0);

      const statuses = await prisma.webhookDelivery.findMany({
        where: {
          deliveryId: {
            in: [noMatch.headers['x-flowforge-delivery'], unusable.headers['x-flowforge-delivery']],
          },
        },
        select: { status: true, workspaceId: true },
      });
      expect(statuses).toEqual([
        { status: 'IGNORED', workspaceId: null },
        { status: 'IGNORED', workspaceId: null },
      ]);
    });

    it('archived workflows no longer trigger', async () => {
      const workflowId = await publishWebhookWorkflow('repo-archived');
      await request(server)
        .post(`/api/v1/workspaces/${ws}/workflows/${workflowId}/archive`)
        .set(bearer(user.accessToken))
        .expect(200);
      expect((await send(signed({ resource: 'repo-archived', data: {} }))).body.runs).toBe(0);
    });
  });

  describe('payload limits', () => {
    it('accepts webhook bodies above the general API limit, up to 1 MB', async () => {
      const msg = signed({ resource: 'nobody', data: {}, padding: 'x'.repeat(500_000) });
      expect((await send(msg)).status).toBe(202);
    });

    it('rejects bodies over 1 MB with 413', async () => {
      const msg = signed({ resource: 'nobody', data: {}, padding: 'x'.repeat(1_100_000) });
      expect((await send(msg)).status).toBe(413);
    });

    it('rejects event data over 256 KB with 413', async () => {
      const msg = signed({ resource: 'nobody', data: { blob: 'x'.repeat(300_000) } });
      expect((await send(msg)).status).toBe(413);
    });
  });
});
