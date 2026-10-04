import { getQueueToken } from '@nestjs/bullmq';
import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { App } from 'supertest/types';
import { HttpPollRunner } from '../../src/execution/http-poll-runner';
import { EgressClient } from '../../src/infrastructure/egress/egress-client';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { JOBS, QUEUES } from '../../src/infrastructure/queue/queue.constants';
import { PollQueue } from '../../src/infrastructure/queue/poll-queue.service';
import { RunQueue } from '../../src/infrastructure/queue/run-queue.service';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { createTestApp } from '../support/create-app';
import { createTestWorker, waitFor } from '../support/create-worker';
import { createVersion, createWorkflow } from '../support/factories';
import { truncateAll } from '../support/test-database';
import { TestNodeControl } from '../support/test-node-types';

const HOST = 'api.flowforge-test.example';
const MINUTE = 60_000;

/**
 * Part 24, slice 3 — http.poll against a local test API (AC-24.9): one run per new item
 * across restarts and concurrent pollers, cursor, limits, failures and backoff, egress guard.
 */
describe('HTTP poll trigger (integration)', () => {
  let api: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let worker: TestingModule;
  let runner: HttpPollRunner;
  let user: RegisteredUser;
  let ws: string;
  let service: Server;
  let base: string;
  let items: unknown[] = [];
  let respond: ((req: IncomingMessage, res: ServerResponse) => boolean) | null = null;
  const seen: string[] = [];

  const auth = () => bearer(user.accessToken);
  const workflows = () => `/api/v1/workspaces/${ws}/workflows`;

  const pollTrigger = (config: object = {}) => ({
    key: 'trigger',
    kind: 'TRIGGER',
    type: 'http.poll',
    config: {
      request: { url: `${base}/items` },
      schedule: { kind: 'interval', timezone: 'UTC', everyMinutes: 5 },
      items: { path: 'data' },
      identity: { path: 'id' },
      ...config,
    },
  });
  const log = {
    key: 'log',
    kind: 'ACTION',
    type: 'util.log',
    config: { message: 'item {{ trigger.item.title }}' },
  };

  async function publish(config: object = {}): Promise<string> {
    const wf = await request(server)
      .post(workflows())
      .set(auth())
      .send({ name: 'poll' })
      .expect(201);
    const draft = await request(server)
      .put(`${workflows()}/${wf.body.id}/draft`)
      .set(auth())
      .send({
        expectedRevision: 0,
        definition: {
          schemaVersion: 1,
          nodes: [pollTrigger(config), log],
          edges: [{ from: 'trigger', to: 'log' }],
        },
      })
      .expect(200);
    expect(draft.body.issues).toEqual([]);
    await request(server)
      .post(`${workflows()}/${wf.body.id}/publish`)
      .set(auth())
      .send({ expectedRevision: 1 })
      .expect(201);
    return wf.body.id;
  }

  const scheduleOf = (workflowId: string) =>
    prisma.workflowSchedule.findUniqueOrThrow({ where: { workflowId } });
  const stateOf = (workflowId: string) =>
    prisma.httpPollState.findUnique({ where: { workflowId } });
  const runsOf = (workflowId: string) =>
    prisma.workflowRun.findMany({ where: { workflowId }, orderBy: { createdAt: 'asc' } });
  const poll = async (workflowId: string) =>
    runner.run({
      scheduleId: (await scheduleOf(workflowId)).id,
      occurrence: new Date().toISOString(),
    });
  const item = (id: number) => ({ id, title: `Item ${id}` });

  beforeAll(async () => {
    service = createServer((req, res) => {
      seen.push(req.url!);
      if (respond?.(req, res)) return;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: items, next: `cur-${items.length}` }));
    });
    await new Promise<void>((r) => service.listen(0, '127.0.0.1', r));
    const port = (service.address() as AddressInfo).port;
    base = `http://${HOST}:${port}`;

    api = await createTestApp();
    server = api.getHttpServer();
    prisma = api.get(PrismaService);
    worker = await createTestWorker(new TestNodeControl());
    worker.get(EgressClient).allowForTests('127.0.0.1', port, HOST);
    runner = worker.get(HttpPollRunner);
    await truncateAll(prisma);
    user = await registerUser(server);
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: user.id } }))
      .workspaceId;
  });

  beforeEach(() => {
    items = [];
    respond = null;
    seen.length = 0;
  });

  afterAll(async () => {
    await worker?.close();
    await api.get(RunQueue).queue.obliterate({ force: true });
    await api.get(PollQueue).queue.obliterate({ force: true });
    await api.close();
    await new Promise((r) => service.close(r));
  });

  it('publishing creates a POLL schedule; the first poll seeds without runs', async () => {
    const id = await publish();
    expect(await scheduleOf(id)).toMatchObject({ kind: 'POLL', active: true, cron: '*/5 * * * *' });
    const before = await request(server).get(`${workflows()}/${id}/poll`).set(auth()).expect(200);
    expect(before.body).toMatchObject({ schedule: { active: true }, state: null });

    items = [item(1), item(2)];
    expect(await poll(id)).toEqual({ kind: 'seeded', items: 2 });
    expect(await runsOf(id)).toEqual([]);
    const after = await request(server).get(`${workflows()}/${id}/poll`).set(auth()).expect(200);
    expect(after.body.state).toMatchObject({
      status: 'OK',
      seeded: true,
      itemsFired: 0,
      consecutiveFailures: 0,
    });
    expect(after.body.state).not.toHaveProperty('seenIds');
  });

  it('new items start one run each; repeated items never fire again', async () => {
    const id = await publish();
    items = [item(1)];
    await poll(id); // seed
    items = [item(1), item(2), item(3)];
    expect(await poll(id)).toEqual({ kind: 'polled', fired: 2, newItems: 2 });
    // Runs of one poll are inserted together (same createdAt): order by item id.
    const runs = (await runsOf(id)).sort((x, y) =>
      (x.triggerInput as { itemId: string }).itemId.localeCompare(
        (y.triggerInput as { itemId: string }).itemId,
      ),
    );
    expect(
      runs.map((r) => [r.triggerSource, (r.triggerInput as { itemId: string }).itemId]),
    ).toEqual([
      ['POLL', '2'],
      ['POLL', '3'],
    ]);
    expect(runs[0].triggerInput).toMatchObject({
      triggerType: 'POLL',
      item: item(2),
      scheduleId: expect.any(String),
    });
    expect(await poll(id)).toEqual({ kind: 'polled', fired: 0, newItems: 0 });

    // With the seen window lost (as after a restore): items that already fired are protected by
    // the unique run key; only item 1, which was seeded (never fired), is new again.
    await prisma.httpPollState.update({ where: { workflowId: id }, data: { seenIds: [] } });
    expect(await poll(id)).toMatchObject({ kind: 'polled', fired: 1 });
    expect(
      (await runsOf(id)).map((r) => (r.triggerInput as { itemId: string }).itemId).sort(),
    ).toEqual(['1', '2', '3']);

    const done = await waitFor(
      async () => {
        const r = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runs[0].id } });
        return r.status === 'SUCCEEDED' ? r : undefined;
      },
      { timeoutMs: 30_000, what: 'the poll run' },
    );
    const steps = await prisma.stepRun.findMany({
      where: { runId: done.id },
      orderBy: { sequence: 'asc' },
    });
    expect(steps[1].sanitizedOutput).toEqual({ message: 'item Item 2' });
  });

  it('concurrent pollers create exactly one run per new item', async () => {
    const id = await publish();
    await poll(id); // seed (empty)
    items = [item(10), item(11), item(12)];
    const outcomes = await Promise.all([poll(id), poll(id), poll(id)]);
    expect(outcomes.reduce((n, o) => n + ('fired' in o ? o.fired : 0), 0)).toBe(3);
    expect(await runsOf(id)).toHaveLength(3);
  });

  it('sends the cursor from the previous response; honours maxItemsPerPoll', async () => {
    const id = await publish({
      cursor: { responsePath: 'next', queryParam: 'since' },
      maxItemsPerPoll: 2,
    });
    items = [item(1)];
    await poll(id);
    expect(seen[0]).toBe('/items');
    items = [item(1), item(2), item(3), item(4)];
    expect(await poll(id)).toMatchObject({ fired: 2, newItems: 3 });
    expect(seen[1]).toBe('/items?since=cur-1');
    expect(await poll(id)).toMatchObject({ fired: 1 });
    expect(seen[2]).toBe('/items?since=cur-4');
    expect(await runsOf(id)).toHaveLength(3);
  });

  it('identifies items by content when no id path is set; can fire on the first poll', async () => {
    const id = await publish({ identity: {}, seedOnFirstPoll: false, items: {} });
    items = [item(1)];
    // items: {} → the whole response is one item.
    expect(await poll(id)).toMatchObject({ kind: 'polled', fired: 1 });
    expect(await poll(id)).toMatchObject({ fired: 0 }); // same content
    items = [item(2)];
    expect(await poll(id)).toMatchObject({ fired: 1 });
  });

  it('repeated failures mark the trigger FAILING and back off', async () => {
    const id = await publish();
    respond = (_req, res) => {
      res.writeHead(500);
      res.end();
      return true;
    };
    for (let i = 0; i < 3; i++)
      expect(await poll(id)).toMatchObject({
        kind: 'failed',
        category: 'TRANSIENT_INFRASTRUCTURE',
      });
    const state = await stateOf(id);
    expect(state).toMatchObject({
      status: 'FAILING',
      consecutiveFailures: 3,
      lastError: expect.stringContaining('HTTP 500'),
    });
    expect(state!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await poll(id)).toEqual({ kind: 'backing-off' });

    // Recovery once the backoff has passed.
    respond = null;
    await prisma.httpPollState.update({
      where: { workflowId: id },
      data: { nextAttemptAt: new Date(Date.now() - 1) },
    });
    expect(await poll(id)).toMatchObject({ kind: 'seeded' });
    expect(await stateOf(id)).toMatchObject({ status: 'OK', consecutiveFailures: 0 });
  });

  it('the egress guard applies: a redirect to a private address fails the poll', async () => {
    const id = await publish();
    respond = (_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return true;
    };
    expect(await poll(id)).toEqual({ kind: 'failed', category: 'VALIDATION' });
    expect((await stateOf(id))!.lastError).toMatch(/Destination not allowed/);
  });

  it('non-JSON responses and missing ids are poll data errors', async () => {
    const id = await publish();
    respond = (_req, res) => {
      res.end('<html>');
      return true;
    };
    expect(await poll(id)).toEqual({ kind: 'failed', category: 'POLL_DATA' });
    respond = null;
    items = [{ title: 'no id' }];
    expect(await poll(id)).toEqual({ kind: 'failed', category: 'POLL_DATA' });
  });

  it('changing the request or identity starts from scratch', async () => {
    const id = await publish();
    items = [item(1)];
    await poll(id);
    const wf = await request(server).get(`${workflows()}/${id}`).set(auth());
    const definition = wf.body.draftDefinition;
    definition.nodes[0].config.identity = { path: 'title' };
    const draft = await request(server)
      .put(`${workflows()}/${id}/draft`)
      .set(auth())
      .send({ expectedRevision: wf.body.draftRevision, definition })
      .expect(200);
    await request(server)
      .post(`${workflows()}/${id}/publish`)
      .set(auth())
      .send({ expectedRevision: draft.body.draftRevision })
      .expect(201);
    expect(await poll(id)).toEqual({ kind: 'seeded', items: 1 }); // re-seeded under the new identity
  });

  it('archived or unpublished poll workflows never poll', async () => {
    const id = await publish();
    await request(server).post(`${workflows()}/${id}/archive`).set(auth()).expect(200);
    expect(await poll(id)).toEqual({ kind: 'not-live' });
    expect(seen).toEqual([]);
  });

  it('enforces the per-workspace limit of active poll triggers at publish', async () => {
    const other = await registerUser(server);
    const otherWs = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: other.id } }))
      .workspaceId;
    // Fill the other workspace up to the default limit (20) directly.
    for (let i = 0; i < 20; i++) {
      const wf = await createWorkflow(prisma, otherWs);
      const version = await createVersion(prisma, wf);
      await prisma.workflowSchedule.create({
        data: {
          workspaceId: otherWs,
          workflowId: wf.id,
          workflowVersionId: version.id,
          kind: 'POLL',
          cron: '*/5 * * * *',
          timezone: 'UTC',
          config: {},
          description: 'x',
          nextRunAt: new Date(Date.now() + MINUTE),
        },
      });
    }
    const wf = await request(server)
      .post(`/api/v1/workspaces/${otherWs}/workflows`)
      .set(bearer(other.accessToken))
      .send({ name: 'p' })
      .expect(201);
    await request(server)
      .put(`/api/v1/workspaces/${otherWs}/workflows/${wf.body.id}/draft`)
      .set(bearer(other.accessToken))
      .send({
        expectedRevision: 0,
        definition: {
          schemaVersion: 1,
          nodes: [pollTrigger(), log],
          edges: [{ from: 'trigger', to: 'log' }],
        },
      })
      .expect(200);
    const res = await request(server)
      .post(`/api/v1/workspaces/${otherWs}/workflows/${wf.body.id}/publish`)
      .set(bearer(other.accessToken))
      .send({ expectedRevision: 1 })
      .expect(422);
    expect(res.body.details).toMatchObject({ code: 'POLL_QUOTA_EXCEEDED', limit: 20 });
  });

  it('end to end: schedule tick → poll queue → poll → runs → SUCCEEDED', async () => {
    const id = await publish({ seedOnFirstPoll: false });
    items = [item(100)];
    await prisma.workflowSchedule.update({
      where: { workflowId: id },
      data: { nextRunAt: new Date(Math.floor(Date.now() / (5 * MINUTE)) * 5 * MINUTE) },
    });
    await worker.get<Queue>(getQueueToken(QUEUES.MAINTENANCE)).add(JOBS.EVALUATE_SCHEDULES, {});
    const run = await waitFor(
      async () => {
        const [r] = await runsOf(id);
        return r && ['SUCCEEDED', 'FAILED'].includes(r.status) ? r : undefined;
      },
      { timeoutMs: 30_000, what: 'the polled run' },
    );
    expect(run).toMatchObject({ status: 'SUCCEEDED', triggerSource: 'POLL' });
    expect((await scheduleOf(id)).nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });
});
