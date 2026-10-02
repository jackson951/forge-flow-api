import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule } from '@nestjs/testing';
import { RunStatus } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { NodeTypeCatalog } from '../../src/engine/catalog/node-type-catalog';
import { RunWorkerService } from '../../src/execution/run-worker.service';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RunQueue } from '../../src/infrastructure/queue/run-queue.service';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { createTestApp } from '../support/create-app';
import { createTestWorker, waitFor } from '../support/create-worker';
import { createRun } from '../support/factories';
import { FAKE_SECRETS } from '../support/fake-secrets';
import { truncateAll } from '../support/test-database';
import { registerTestTypes, TestNodeControl } from '../support/test-node-types';

type Node = { key: string; kind: string; type: string; config?: Record<string, unknown> };
const trigger: Node = { key: 'start', kind: 'TRIGGER', type: 'manual.trigger', config: {} };
const action = (key: string, type: string, config: Record<string, unknown> = {}): Node => ({
  key,
  kind: 'ACTION',
  type,
  config,
});
const chain = (...nodes: Node[]) => ({
  schemaVersion: 1,
  nodes: [trigger, ...nodes],
  edges: nodes.map((n, i) => ({ from: i === 0 ? 'start' : nodes[i - 1].key, to: n.key })),
});

describe('Run history and observability (integration)', () => {
  let api: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let worker: TestingModule;
  let admin: RegisteredUser;
  let member: RegisteredUser;
  let ws: string;
  const control = new TestNodeControl();
  const logged: unknown[][] = [];

  const auth = (user = admin) => bearer(user.accessToken);
  const base = () => `/api/v1/workspaces/${ws}`;

  async function publish(definition: object, name = 'wf'): Promise<string> {
    const wf = await request(server).post(`${base()}/workflows`).set(auth()).send({ name });
    const draft = await request(server)
      .put(`${base()}/workflows/${wf.body.id}/draft`)
      .set(auth())
      .send({ expectedRevision: 0, definition });
    expect(draft.body.issues).toEqual([]);
    await request(server)
      .post(`${base()}/workflows/${wf.body.id}/publish`)
      .set(auth())
      .send({ expectedRevision: 1 })
      .expect(201);
    return wf.body.id;
  }

  async function start(workflowId: string, input: object = {}, headers: object = {}) {
    const res = await request(server)
      .post(`${base()}/workflows/${workflowId}/runs`)
      .set({ ...auth(), ...headers })
      .send({ input })
      .expect(202);
    return res.body.runId as string;
  }

  const settled = (id: string) =>
    waitFor(
      async () => {
        const r = await prisma.workflowRun.findUniqueOrThrow({ where: { id } });
        return (['SUCCEEDED', 'FAILED', 'CANCELLED'] as RunStatus[]).includes(r.status)
          ? r
          : undefined;
      },
      { what: `run ${id}` },
    );
  const runAndSettle = async (workflowId: string, input: object = {}) => {
    const id = await start(workflowId, input);
    await settled(id);
    return id;
  };
  const ids = (res: request.Response) => res.body.items.map((r: { id: string }) => r.id);
  const list = (query: Record<string, string | number> = {}, user = admin) =>
    request(server).get(`${base()}/runs`).query(query).set(auth(user));

  let okFlow: string;
  let failFlow: string;
  let okRuns: string[];
  let failRuns: string[];

  beforeAll(async () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      const original = PinoLogger.prototype[level];
      jest.spyOn(PinoLogger.prototype, level).mockImplementation(function (
        this: PinoLogger,
        ...args: unknown[]
      ) {
        logged.push(args);
        return (original as (...a: unknown[]) => void).apply(this, args);
      });
    }
    api = await createTestApp();
    server = api.getHttpServer();
    prisma = api.get(PrismaService);
    registerTestTypes(api.get(NodeTypeCatalog));
    worker = await createTestWorker(control);
    await truncateAll(prisma);
    admin = await registerUser(server);
    member = await registerUser(server);
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: admin.id } }))
      .workspaceId;
    await prisma.workspaceMember.create({
      data: { workspaceId: ws, userId: member.id, role: 'MEMBER' },
    });

    okFlow = await publish(chain(action('log', 'util.log', { message: 'hi' })), 'Healthy');
    failFlow = await publish(
      chain(
        action('echo', 'test.echo'),
        action('fail', 'test.fail', { mode: 'permanent' }),
        action('never', 'util.log', { message: 'not reached' }),
      ),
      'Broken',
    );
    okRuns = [];
    for (let i = 0; i < 3; i++) okRuns.push(await runAndSettle(okFlow));
    failRuns = [];
    for (let i = 0; i < 2; i++) failRuns.push(await runAndSettle(failFlow, { attempt: i }));
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await worker?.close();
    await api.get(RunQueue).queue.obliterate({ force: true });
    await api.close();
  });

  describe('a failed run is diagnosable from the API (AC-16.1)', () => {
    it('detail shows the error, its category and the failed step', async () => {
      const res = await request(server).get(`${base()}/runs/${failRuns[0]}`).set(auth(member));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: failRuns[0],
        workflowId: failFlow,
        workflowName: 'Broken',
        version: 1,
        status: 'FAILED',
        triggerSource: 'MANUAL',
        attemptCount: 1,
        triggerInput: { attempt: 0 },
        retryOfRunId: null,
        retriedByRunIds: [],
        correlationId: expect.any(String),
        durationMs: expect.any(Number),
        error: {
          category: 'PERMANENT_PROVIDER_ERROR',
          message: 'provider rejected the request',
          retryable: false,
          description: expect.stringContaining('retrying would not help'),
        },
        failedStep: {
          nodeKey: 'fail',
          nodeType: 'test.fail',
          error: { category: 'PERMANENT_PROVIDER_ERROR', retryable: false },
        },
      });
    });

    it('steps are listed in execution order with status, attempts and errors', async () => {
      const res = await request(server)
        .get(`${base()}/runs/${failRuns[0]}/steps`)
        .set(auth(member));
      expect(res.status).toBe(200);
      expect(
        res.body.map((s: { nodeKey: string; status: string }) => [s.nodeKey, s.status]),
      ).toEqual([
        ['start', 'SUCCEEDED'],
        ['echo', 'SUCCEEDED'],
        ['fail', 'FAILED'],
        ['never', 'SKIPPED'],
      ]);
      const fail = res.body[2];
      expect(fail).toMatchObject({
        sequence: 3,
        attemptCount: 1,
        durationMs: expect.any(Number),
        error: { category: 'PERMANENT_PROVIDER_ERROR', message: 'provider rejected the request' },
        externalRef: null,
      });
      expect(res.body[1].output).toMatchObject({ triggerInput: { attempt: 0 } });
    });

    it('secrets in trigger input and step data are redacted in every response', async () => {
      const runId = await runAndSettle(failFlow, {
        accessToken: 'plain-access-token-canary',
        note: `use ${FAKE_SECRETS.slack} for alerts`,
      });
      const detail = await request(server).get(`${base()}/runs/${runId}`).set(auth());
      const steps = await request(server).get(`${base()}/runs/${runId}/steps`).set(auth());
      const body = JSON.stringify([detail.body, steps.body]);
      expect(body).not.toContain('plain-access-token-canary');
      expect(body).not.toContain(FAKE_SECRETS.slack);
      expect(detail.body.triggerInput).toEqual({
        accessToken: '[REDACTED]',
        note: 'use [REDACTED] for alerts',
      });
    });
  });

  describe('list: filters and pagination (AC-16.5)', () => {
    it('lists newest first with summaries', async () => {
      const res = await list({ workflowId: okFlow });
      expect(res.status).toBe(200);
      expect(ids(res)).toEqual([...okRuns].reverse());
      expect(res.body.items[0]).toMatchObject({
        workflowName: 'Healthy',
        version: 1,
        status: 'SUCCEEDED',
        error: null,
      });
      expect(res.body.nextCursor).toBeNull();
    });

    it('filters by workflow, status, trigger source and time, alone and combined', async () => {
      expect(ids(await list({ status: 'FAILED' }))).toEqual(expect.arrayContaining(failRuns));
      expect(
        (await list({ status: 'FAILED' })).body.items.every(
          (r: { status: string }) => r.status === 'FAILED',
        ),
      ).toBe(true);
      expect(ids(await list({ workflowId: failFlow, status: 'SUCCEEDED' }))).toEqual([]);
      expect(ids(await list({ workflowId: okFlow, status: 'SUCCEEDED' }))).toHaveLength(3);
      expect(ids(await list({ triggerSource: 'WEBHOOK' }))).toEqual([]);

      const first = await prisma.workflowRun.findUniqueOrThrow({ where: { id: okRuns[0] } });
      const last = await prisma.workflowRun.findUniqueOrThrow({ where: { id: okRuns[2] } });
      const window = await list({
        workflowId: okFlow,
        from: first.createdAt.toISOString(),
        to: last.createdAt.toISOString(), // exclusive
      });
      expect(ids(window)).toEqual([okRuns[1], okRuns[0]]);
      expect(ids(await list({ from: new Date(Date.now() + 60_000).toISOString() }))).toEqual([]);
    });

    it('caps the page size at 100 and rejects bad parameters', async () => {
      expect((await list({ limit: 101 })).status).toBe(400);
      expect((await list({ limit: 100 })).status).toBe(200);
      expect((await list({ cursor: 'not-a-cursor' })).status).toBe(400);
      expect((await list({ status: 'DONE' })).status).toBe(400);
      expect((await list({ from: 'yesterday' })).status).toBe(400);
    });

    it('pages correctly through runs created in the same millisecond (id tie-break)', async () => {
      const version = await prisma.workflowVersion.findFirstOrThrow({
        where: { workflowId: okFlow },
      });
      const sameInstant = new Date('2026-01-01T00:00:00.000Z');
      const created = await Promise.all(
        Array.from({ length: 5 }, () => createRun(prisma, version, { createdAt: sameInstant })),
      );
      const window = { from: sameInstant.toISOString(), to: '2026-01-01T00:00:00.001Z' };

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res: request.Response = await list({
          ...window,
          limit: 2,
          ...(cursor && { cursor }),
        });
        seen.push(...ids(res));
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(5);
      expect([...seen].sort()).toEqual(created.map((r) => r.id).sort());
    });

    it('pages are stable while new runs are created: no duplicates, no misses', async () => {
      const flow = await publish(chain(action('log', 'util.log', { message: 'p' })), 'Paged');
      const existing: string[] = [];
      for (let i = 0; i < 7; i++) existing.push(await start(flow));

      const seen: string[] = [];
      let cursor: string | null = null;
      let page = 0;
      do {
        const res: request.Response = await list({
          workflowId: flow,
          limit: 3,
          ...(cursor && { cursor }),
        });
        expect(res.status).toBe(200);
        seen.push(...ids(res));
        cursor = res.body.nextCursor;
        if (page++ === 0) {
          await start(flow); // inserted between page requests
          await start(flow);
        }
      } while (cursor);

      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(expect.arrayContaining(existing));
      expect(seen.filter((id) => !existing.includes(id))).toEqual([]); // newer runs never appear on later pages
    });
  });

  describe('cancel and retry (AC-16.6)', () => {
    const cancel = (runId: string, user = admin) =>
      request(server).post(`${base()}/runs/${runId}/cancel`).set(auth(user));
    const retry = (runId: string) =>
      request(server).post(`${base()}/runs/${runId}/retry`).set(auth()).send({});

    it('cancels a QUEUED run immediately and removes its job', async () => {
      const enqueue = jest.spyOn(api.get(RunQueue), 'enqueue').mockResolvedValue(); // keep it queued
      const runId = await start(okFlow);
      enqueue.mockRestore();
      // A job waiting in the queue (delayed, so no worker takes it before the cancel).
      await api.get(RunQueue).queue.add('execute-run', { runId }, { jobId: runId, delay: 60_000 });

      const res = await cancel(runId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ runId, status: 'CANCELLED', cancelRequested: true });
      expect(await api.get(RunQueue).queue.getJob(runId)).toBeUndefined();

      // A worker that still gets the job leaves it cancelled.
      await worker
        .get(RunWorkerService)
        .process(runId, { jobId: runId, attemptsMade: 0, maxAttempts: 3 });
      const detail = await request(server).get(`${base()}/runs/${runId}`).set(auth());
      expect(detail.body).toMatchObject({ status: 'CANCELLED', error: { category: 'CANCELLED' } });
      const audit = await prisma.auditEvent.findFirst({
        where: { action: 'run.cancelled', targetId: runId },
      });
      expect(audit).not.toBeNull();
    });

    it('a RUNNING run stops before its next step', async () => {
      const gate = control.hold();
      const flow = await publish(
        chain(action('wait', 'test.wait'), action('after', 'util.log', { message: 'no' })),
        'Cancellable',
      );
      const runId = await start(flow);
      await gate.entered;
      const res = await cancel(runId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ runId, status: 'RUNNING', cancelRequested: true });
      gate.release();

      expect((await settled(runId)).status).toBe('CANCELLED');
      const steps = await request(server).get(`${base()}/runs/${runId}/steps`).set(auth());
      expect(
        steps.body.map((s: { nodeKey: string; status: string }) => [s.nodeKey, s.status]),
      ).toEqual([
        ['start', 'SUCCEEDED'],
        ['wait', 'SUCCEEDED'],
        ['after', 'SKIPPED'],
      ]);
    });

    it('terminal runs cannot be cancelled; only ADMINs can cancel or retry', async () => {
      const done = await cancel(okRuns[0]);
      expect(done.status).toBe(409);
      expect(done.body.details).toEqual({ status: 'SUCCEEDED' });
      expect((await cancel(failRuns[0], member)).status).toBe(403);
      expect((await cancel(randomUUID())).status).toBe(404);
      expect((await retry(okRuns[0])).status).toBe(409);

      const retried = await retry(failRuns[1]);
      expect(retried.status).toBe(202);
      await settled(retried.body.runId);
      const detail = await request(server).get(`${base()}/runs/${failRuns[1]}`).set(auth());
      expect(detail.body.retriedByRunIds).toEqual([retried.body.runId]);
      expect(ids(await list({ triggerSource: 'RETRY' }))).toEqual([retried.body.runId]);
    });
  });

  it('run history survives republishing and archiving the workflow (AC-16.3)', async () => {
    await request(server)
      .put(`${base()}/workflows/${okFlow}/draft`)
      .set(auth())
      .send({
        expectedRevision: 1,
        definition: chain(action('log', 'util.log', { message: 'v2' })),
      })
      .expect(200);
    await request(server)
      .post(`${base()}/workflows/${okFlow}/publish`)
      .set(auth())
      .send({ expectedRevision: 2 })
      .expect(201);
    const v2Run = await runAndSettle(okFlow);
    await request(server).post(`${base()}/workflows/${okFlow}/archive`).set(auth()).expect(200);

    const res = await list({ workflowId: okFlow });
    const byId = new Map(
      res.body.items.map((r: { id: string; version: number }) => [r.id, r.version]),
    );
    for (const id of okRuns) expect(byId.get(id)).toBe(1);
    expect(byId.get(v2Run)).toBe(2);
    expect(
      (await request(server).get(`${base()}/runs/${okRuns[0]}`).set(auth())).body.version,
    ).toBe(1);
  });

  it('dashboard summarises the last 24 h / 7 d, top failing workflows and recent failures (FR-16.5)', async () => {
    const res = await request(server).get(`${base()}/dashboard`).set(auth(member));
    expect(res.status).toBe(200);
    const since = (hours: number) => new Date(Date.now() - hours * 3600_000);
    const count = (hours: number, status?: RunStatus) =>
      prisma.workflowRun.count({
        where: { workspaceId: ws, createdAt: { gte: since(hours) }, ...(status && { status }) },
      });
    expect(res.body.runs.last24h).toMatchObject({
      total: await count(24),
      FAILED: await count(24, 'FAILED'),
      SUCCEEDED: await count(24, 'SUCCEEDED'),
    });
    expect(res.body.runs.last7d.total).toBe(await count(24 * 7));
    // Older runs (the 2026-01-01 fixtures) are outside both windows.
    expect(res.body.runs.last7d.total).toBeLessThan(
      await prisma.workflowRun.count({ where: { workspaceId: ws } }),
    );
    expect(res.body.topFailingWorkflows[0]).toEqual({
      workflowId: failFlow,
      workflowName: 'Broken',
      failedRuns: expect.any(Number),
    });
    expect(res.body.recentFailures.map((f: { runId: string }) => f.runId)).toEqual(
      expect.arrayContaining(failRuns),
    );
    expect(res.body.recentFailures[0]).toMatchObject({
      workflowName: 'Broken',
      error: { category: 'PERMANENT_PROVIDER_ERROR', retryable: false },
    });
  });

  it('one correlation id links the API request, the enqueue and every worker log line (AC-16.2, AC-16.4)', async () => {
    const correlationId = `corr-${randomUUID()}`;
    const flow = await publish(chain(action('log', 'util.log', { message: 'trace me' })), 'Traced');
    const res = await request(server)
      .post(`${base()}/workflows/${flow}/runs`)
      .set({ ...auth(), 'x-request-id': correlationId })
      .send({ input: { secret: 'canary-secret-value', token: FAKE_SECRETS.github } })
      .expect(202);
    expect(res.headers['x-request-id']).toBe(correlationId); // = the API request log's req.id
    const runId = res.body.runId;
    await settled(runId);
    expect(
      (await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } })).correlationId,
    ).toBe(correlationId);

    const lines = logged
      .map(([fields, message]) => ({ fields: fields as Record<string, unknown>, message }))
      .filter((l) => typeof l.fields === 'object' && l.fields?.runId === runId);
    const messages = (m: string) => lines.filter((l) => l.message === m);
    for (const m of [
      'Run enqueued',
      'Run started',
      'Step started',
      'Step succeeded',
      'Run finished',
    ]) {
      expect(messages(m).length).toBeGreaterThan(0);
      for (const l of messages(m)) expect(l.fields.correlationId).toBe(correlationId);
    }
    expect(messages('Step started')[0].fields).toMatchObject({
      workspaceId: ws,
      workflowId: flow,
      workflowVersionId: expect.any(String),
      jobId: runId,
      attempt: 1,
    });

    const all = JSON.stringify(logged);
    expect(all).not.toContain('canary-secret-value');
    expect(all).not.toContain(FAKE_SECRETS.github);
    expect(all).not.toContain('plain-access-token-canary');
    expect(all).not.toContain(FAKE_SECRETS.slack);
  });
});
