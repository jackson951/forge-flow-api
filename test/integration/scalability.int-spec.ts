import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppConfigService } from '../../src/config/app-config.service';
import { NodeTypeCatalog } from '../../src/engine/catalog/node-type-catalog';
import { ProviderConcurrencyLimiter } from '../../src/engine/execution/provider-slots';
import { RunWorkerService } from '../../src/execution/run-worker.service';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RunQueue } from '../../src/infrastructure/queue/run-queue.service';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { createTestApp } from '../support/create-app';
import { createTestWorker, waitFor } from '../support/create-worker';
import { truncateAll } from '../support/test-database';
import { registerTestTypes, TestNodeControl } from '../support/test-node-types';

type Node = { key: string; kind: string; type: string; config?: Record<string, unknown> };
const action = (key: string, type: string, config: Record<string, unknown> = {}): Node => ({
  key,
  kind: 'ACTION',
  type,
  config,
});
const chain = (trigger: Node, ...nodes: Node[]) => ({
  schemaVersion: 1,
  nodes: [trigger, ...nodes],
  edges: nodes.map((n, i) => ({ from: i === 0 ? trigger.key : nodes[i - 1].key, to: n.key })),
});
const manual: Node = { key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger' };

/** Manual-run backpressure at a tiny threshold (the default is 5 000 waiting jobs). */
class LowThresholdConfig extends AppConfigService {
  override get queue() {
    return { ...super.queue, backpressureThreshold: 3 };
  }
}

const SECRET = process.env.WEBHOOK_TEST_SECRET!;

function signedWebhook(server: App, resource: string) {
  const raw = JSON.stringify({ resource, data: {} });
  const ts = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex');
  return request(server)
    .post('/api/v1/webhooks/test')
    .set({
      'content-type': 'application/json',
      'x-flowforge-delivery': randomUUID(),
      'x-flowforge-event': 'load.event',
      'x-flowforge-timestamp': String(ts),
      'x-flowforge-signature': `sha256=${signature}`,
    })
    .send(raw);
}

/**
 * Part 21 — horizontal scaling. Separate Nest applications in one process share nothing but
 * Postgres and Redis, exactly like separate containers would.
 */
describe('Scalability (integration)', () => {
  let a: NestExpressApplication;
  let b: NestExpressApplication;
  let prisma: PrismaService;
  let user: RegisteredUser;
  let ws: string;
  const queries: string[] = [];

  async function publish(server: App, definition: object): Promise<string> {
    const base = `/api/v1/workspaces/${ws}/workflows`;
    const wf = await request(server)
      .post(base)
      .set(bearer(user.accessToken))
      .send({ name: 'wf' })
      .expect(201);
    const draft = await request(server)
      .put(`${base}/${wf.body.id}/draft`)
      .set(bearer(user.accessToken))
      .send({ expectedRevision: 0, definition });
    expect(draft.body.issues).toEqual([]);
    await request(server)
      .post(`${base}/${wf.body.id}/publish`)
      .set(bearer(user.accessToken))
      .send({ expectedRevision: 1 })
      .expect(201);
    return wf.body.id;
  }

  const start = (server: App, workflowId: string) =>
    request(server)
      .post(`/api/v1/workspaces/${ws}/workflows/${workflowId}/runs`)
      .set(bearer(user.accessToken))
      .send({ input: {} });

  const finished = (ids: string[], timeoutMs = 60_000) =>
    waitFor(
      async () => {
        const done = await prisma.workflowRun.count({
          where: { id: { in: ids }, status: { in: ['SUCCEEDED', 'FAILED', 'CANCELLED'] } },
        });
        return done === ids.length ? true : undefined;
      },
      { timeoutMs, intervalMs: 200, what: `${ids.length} runs to finish` },
    );

  beforeAll(async () => {
    // Instance A logs every SQL statement so FR-21.7 can count them.
    a = await createTestApp((x) =>
      x.overrideProvider(PrismaService).useFactory({
        inject: [AppConfigService],
        factory: (config: AppConfigService) => {
          const client = new PrismaService(config, { log: [{ emit: 'event', level: 'query' }] });
          (client as unknown as { $on(e: 'query', cb: (q: { query: string }) => void): void }).$on(
            'query',
            (q) => queries.push(q.query),
          );
          return client;
        },
      }),
    );
    b = await createTestApp();
    for (const app of [a, b]) registerTestTypes(app.get(NodeTypeCatalog));
    prisma = a.get(PrismaService);
    await truncateAll(prisma);
    user = await registerUser(a.getHttpServer());
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: user.id } }))
      .workspaceId;
  });

  afterAll(async () => {
    await a.get(RunQueue).queue.obliterate({ force: true });
    await a.close();
    await b.close();
  });

  describe('stateless API (FR-21.1)', () => {
    it('a session from instance A works on instance B, and B can refresh it', async () => {
      await request(b.getHttpServer())
        .get('/api/v1/workspaces')
        .set(bearer(user.accessToken))
        .expect(200);
      const refreshed = await request(b.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(200);
      // Rotation is recorded in the database: A now refuses the old refresh token.
      await request(a.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(401);
      user = { ...user, ...refreshed.body };
      await request(a.getHttpServer())
        .get('/api/v1/workspaces')
        .set(bearer(user.accessToken))
        .expect(200);
    });
  });

  describe('two API and two worker instances (FR-21.2, AC-21.1)', () => {
    const control = new TestNodeControl();
    let workers: TestingModule[] = [];

    beforeAll(async () => {
      workers = [await createTestWorker(control), await createTestWorker(control)];
    });
    afterAll(async () => {
      for (const w of workers) await w.close();
    });

    it('100 runs started through both APIs are each executed exactly once', async () => {
      const servers = [a.getHttpServer(), b.getHttpServer()];
      const workflowId = await publish(
        servers[0],
        chain(
          manual,
          action('send', 'test.sideEffect', { label: 'once' }),
          action('log', 'util.log', { message: 'done' }),
        ),
      );
      const counts = workers.map((w) => jest.spyOn(w.get(RunWorkerService), 'process'));

      const ids: string[] = [];
      for (let i = 0; i < 100; i += 10) {
        const batch = await Promise.all(
          Array.from({ length: 10 }, (_, j) => start(servers[(i + j) % 2], workflowId)),
        );
        for (const res of batch) {
          expect(res.status).toBe(202);
          ids.push(res.body.runId);
        }
      }
      await finished(ids);

      const runs = await prisma.workflowRun.findMany({ where: { id: { in: ids } } });
      expect(runs.every((r) => r.status === 'SUCCEEDED')).toBe(true);
      expect(runs.every((r) => r.attemptCount === 1)).toBe(true);
      const steps = await prisma.stepRun.findMany({ where: { runId: { in: ids } } });
      expect(steps).toHaveLength(300);
      expect(steps.every((s) => s.status === 'SUCCEEDED' && s.attemptCount === 1)).toBe(true);

      // The non-idempotent step ran once per run: 100 calls, 100 distinct runs.
      const sent = control.sideEffects.filter((s) => s.startsWith('once@'));
      expect(sent).toHaveLength(100);
      expect(new Set(sent).size).toBe(100);

      // Both workers took part.
      const perWorker = counts.map((c) => c.mock.calls.length);
      expect(perWorker[0] + perWorker[1]).toBe(100);
      expect(Math.min(...perWorker)).toBeGreaterThan(0);
    });
  });

  describe('per-provider concurrency (FR-21.3)', () => {
    const control = new TestNodeControl();
    let worker: TestingModule;
    // test.wait stands in for a slow provider ("slow"), limited to one step at a time.
    const limiter = new ProviderConcurrencyLimiter(1, (type) =>
      type === 'test.wait' ? 'slow' : undefined,
    );

    beforeAll(async () => {
      worker = await createTestWorker(control, (x) =>
        x.overrideProvider(ProviderConcurrencyLimiter).useValue(limiter),
      );
    });
    afterAll(() => worker.close());

    it('a slow provider holds one slot; runs for other providers keep flowing; no attempts are used up', async () => {
      const server = a.getHttpServer();
      const slow = await publish(server, chain(manual, action('wait', 'test.wait')));
      const fast = await publish(
        server,
        chain(manual, action('log', 'util.log', { message: 'x' })),
      );

      const gate = control.hold();
      const slowIds = (await Promise.all([1, 2, 3].map(() => start(server, slow)))).map(
        (r) => r.body.runId as string,
      );
      await gate.entered;

      // Only one slow step runs; the others are postponed (QUEUED, delayed job, no attempt).
      const fastIds = (await Promise.all([1, 2, 3, 4].map(() => start(server, fast)))).map(
        (r) => r.body.runId as string,
      );
      await finished(fastIds, 15_000);
      expect(limiter.active('slow')).toBe(1);
      // Postponed runs never started their step: it is still PENDING, with no attempt.
      const held = await prisma.stepRun.findMany({
        where: { runId: { in: slowIds }, nodeKey: 'wait' },
      });
      expect(held.map((s) => s.status).sort()).toEqual(['PENDING', 'PENDING', 'RUNNING']);

      gate.release();
      await finished(slowIds, 30_000);
      const runs = await prisma.workflowRun.findMany({ where: { id: { in: slowIds } } });
      expect(runs.every((r) => r.status === 'SUCCEEDED')).toBe(true);
      // Postponements gave their claims back: each run counts a single attempt.
      expect(runs.map((r) => r.attemptCount)).toEqual([1, 1, 1]);
      expect(runs.every((r) => r.lastErrorCategory === null)).toBe(true);
      const steps = await prisma.stepRun.findMany({
        where: { runId: { in: slowIds }, nodeKey: 'wait' },
      });
      expect(steps.every((s) => s.attemptCount === 1)).toBe(true);
      expect(limiter.active('slow')).toBe(0);
    });
  });

  describe('backpressure (FR-21.11)', () => {
    let c: NestExpressApplication;

    beforeAll(async () => {
      c = await createTestApp((x) =>
        x.overrideProvider(AppConfigService).useClass(LowThresholdConfig),
      );
      registerTestTypes(c.get(NodeTypeCatalog));
    });
    afterAll(() => c.close());

    it('refuses manual runs with 429 above the threshold but still accepts webhooks', async () => {
      const server = c.getHttpServer();
      const manualWf = await publish(
        server,
        chain(manual, action('log', 'util.log', { message: 'x' })),
      );
      await publish(
        server,
        chain(
          {
            key: 'trigger',
            kind: 'TRIGGER',
            type: 'test.event',
            config: { event: 'load.event', resource: 'bp' },
          },
          action('log', 'util.log', { message: 'x' }),
        ),
      );
      // No worker in this block: jobs stay waiting.
      await a.get(RunQueue).queue.obliterate({ force: true });
      for (let i = 0; i < 4; i++) expect((await start(server, manualWf)).status).toBe(202);
      await new Promise((r) => setTimeout(r, 1_100)); // the queue depth is sampled once per second

      const refused = await start(server, manualWf);
      expect(refused.status).toBe(429);
      expect(refused.headers['retry-after']).toBe('30');
      expect(refused.body.details).toEqual({ code: 'QUEUE_BACKPRESSURE', retryAfterSeconds: 30 });

      const delivery = await signedWebhook(server, 'bp');
      expect(delivery.status).toBe(202);
      expect(delivery.body.runs).toBe(1);

      await a.get(RunQueue).queue.obliterate({ force: true });
    });
  });

  describe('no N+1 queries (FR-21.7)', () => {
    it('the run list costs the same number of queries for 5 or 20 runs and never reads steps', async () => {
      const server = a.getHttpServer();
      const list = async (limit: number) => {
        queries.length = 0;
        await request(server)
          .get(`/api/v1/workspaces/${ws}/runs?limit=${limit}`)
          .set(bearer(user.accessToken))
          .expect(200);
        return [...queries];
      };
      expect((await prisma.workflowRun.count({ where: { workspaceId: ws } })) >= 20).toBe(true);

      const five = await list(5);
      const twenty = await list(20);
      expect(twenty.length).toBe(five.length);
      expect(twenty.length).toBeLessThanOrEqual(5);
      expect(twenty.some((q) => q.includes('"StepRun"'))).toBe(false);
      // Workflow name and version number come in with the page, not per run.
      expect(twenty.some((q) => q.includes('"Workflow"'))).toBe(true);
    });

    it('a cursor page bounds the index scan at the cursor (createdAt <=), not only a filter', async () => {
      const server = a.getHttpServer();
      const runs = `/api/v1/workspaces/${ws}/runs?limit=5`;
      const first = await request(server).get(runs).set(bearer(user.accessToken)).expect(200);
      queries.length = 0;
      const next = await request(server)
        .get(`${runs}&cursor=${first.body.nextCursor}`)
        .set(bearer(user.accessToken))
        .expect(200);
      expect(next.body.items[0].id).not.toBe(first.body.items[0].id);
      const listQuery = queries.find((q) => q.includes('FROM "public"."WorkflowRun"'))!;
      expect(listQuery).toMatch(/"createdAt" <= \$\d/);
    });

    it('the workflow list does not load definitions', async () => {
      queries.length = 0;
      await request(a.getHttpServer())
        .get(`/api/v1/workspaces/${ws}/workflows?limit=50`)
        .set(bearer(user.accessToken))
        .expect(200);
      const reads = queries.filter((q) => q.startsWith('SELECT'));
      expect(reads.some((q) => q.includes('FROM "public"."Workflow"'))).toBe(true);
      expect(reads.some((q) => q.includes('"draftDefinition"'))).toBe(false);
      expect(reads.some((q) => q.includes('"definition"'))).toBe(false);
      expect(queries.length).toBeLessThanOrEqual(5);
    });
  });
});
