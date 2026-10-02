import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule } from '@nestjs/testing';
import { RunStatus, StepRun, WorkflowRun } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { z } from 'zod';
import { NodeTypeCatalog } from '../../src/engine/catalog/node-type-catalog';
import { RunSweeper, WorkflowRunProcessor } from '../../src/execution/processors';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RunQueue } from '../../src/infrastructure/queue/run-queue.service';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { createTestApp } from '../support/create-app';
import { createTestWorker, waitFor } from '../support/create-worker';
import { truncateAll } from '../support/test-database';
import { registerTestTypes, TestNodeControl } from '../support/test-node-types';

type Node = { key: string; kind: string; type: string; config?: Record<string, unknown> };
type Edge = { from: string; to: string; branch?: 'true' | 'false' };

const trigger: Node = { key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger' };
const action = (key: string, type: string, config: Record<string, unknown> = {}): Node => ({
  key,
  kind: 'ACTION',
  type,
  config,
});
const chain = (...nodes: Node[]) => ({
  schemaVersion: 1,
  nodes: [trigger, ...nodes],
  edges: nodes.map((n, i) => ({ from: i === 0 ? 'trigger' : nodes[i - 1].key, to: n.key })),
});

describe('Queue, worker and execution engine (integration)', () => {
  let api: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let worker: TestingModule | undefined;
  let user: RegisteredUser;
  let ws: string;
  const control = new TestNodeControl();

  const auth = () => bearer(user.accessToken);
  const workflows = () => `/api/v1/workspaces/${ws}/workflows`;

  async function publish(definition: object): Promise<string> {
    const wf = await request(server).post(workflows()).set(auth()).send({ name: 'wf' }).expect(201);
    const draft = await request(server)
      .put(`${workflows()}/${wf.body.id}/draft`)
      .set(auth())
      .send({ expectedRevision: 0, definition });
    expect(draft.body.issues).toEqual([]);
    await request(server)
      .post(`${workflows()}/${wf.body.id}/publish`)
      .set(auth())
      .send({ expectedRevision: 1 })
      .expect(201);
    return wf.body.id;
  }

  const start = (workflowId: string, input: object = {}, headers: Record<string, string> = {}) =>
    request(server)
      .post(`${workflows()}/${workflowId}/runs`)
      .set({ ...auth(), ...headers })
      .send({ input });

  async function startRun(definition: object, input: object = {}): Promise<string> {
    const res = await start(await publish(definition), input);
    expect(res.status).toBe(202);
    return res.body.runId;
  }

  const run = (id: string) => prisma.workflowRun.findUniqueOrThrow({ where: { id } });
  const steps = (runId: string) =>
    prisma.stepRun.findMany({ where: { runId }, orderBy: { sequence: 'asc' } });
  const stepStates = async (runId: string) =>
    Object.fromEntries((await steps(runId)).map((s: StepRun) => [s.nodeKey, s.status]));

  const settled = (id: string, statuses: RunStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED']) =>
    waitFor(
      async () => {
        const r = await run(id);
        return statuses.includes(r.status) ? r : undefined;
      },
      { what: `run ${id} to reach ${statuses.join('/')}` },
    );

  beforeAll(async () => {
    api = await createTestApp();
    server = api.getHttpServer();
    prisma = api.get(PrismaService);
    registerTestTypes(api.get(NodeTypeCatalog));
    api.get(NodeTypeCatalog).register({
      type: 'test.webhook',
      kind: 'TRIGGER',
      displayName: 'Webhook',
      configSchema: z.object({}).strict(),
      route: () => ({ provider: 'GITHUB', eventType: 'x', resourceKey: 'y' }),
    });
    await truncateAll(prisma);

    user = await registerUser(server);
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: user.id } }))
      .workspaceId;
  });

  afterAll(async () => {
    await worker?.close();
    await api.get(RunQueue).queue.obliterate({ force: true });
    await api.close();
  });

  describe('API side, before any worker runs (Part 07)', () => {
    it('queues a run, enqueues job id = run id, and returns 202 without executing (AC-07.1, AC-07.6)', async () => {
      const res = await start(await publish(chain(action('log', 'util.log', { message: 'hi' }))), {
        a: 1,
      });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ runId: expect.any(String), status: 'QUEUED' });

      const created = await run(res.body.runId);
      expect(created).toMatchObject({
        status: 'QUEUED',
        triggerSource: 'MANUAL',
        triggerInput: { a: 1 },
        correlationId: expect.any(String),
        attemptCount: 0,
      });
      const job = await api.get(RunQueue).queue.getJob(res.body.runId);
      expect(job?.data).toEqual({ runId: res.body.runId });

      // Nothing in the API process consumes jobs.
      expect(() => api.get(WorkflowRunProcessor, { strict: false })).toThrow();
      await new Promise((r) => setTimeout(r, 300));
      expect((await run(res.body.runId)).status).toBe('QUEUED');
      expect(await steps(res.body.runId)).toEqual([]);
    });

    it('the same Idempotency-Key returns the same run and enqueues once', async () => {
      const wf = await publish(chain(action('log', 'util.log', { message: 'x' })));
      const a = await start(wf, {}, { 'Idempotency-Key': 'retry-123' });
      const b = await start(wf, {}, { 'Idempotency-Key': 'retry-123' });
      expect(a.status).toBe(202);
      expect(b.body.runId).toBe(a.body.runId);
      expect(await prisma.workflowRun.count({ where: { workflowId: wf } })).toBe(1);

      const other = await publish(chain(action('log', 'util.log', { message: 'y' })));
      expect((await start(other, {}, { 'Idempotency-Key': 'retry-123' })).status).toBe(409);
      expect((await start(wf, {}, { 'Idempotency-Key': 'bad key!' })).status).toBe(400);
    });

    it('refuses unpublished, archived and webhook-triggered workflows', async () => {
      const draftOnly = await request(server).post(workflows()).set(auth()).send({ name: 'd' });
      expect((await start(draftOnly.body.id)).status).toBe(409);

      const archived = await publish(chain(action('log', 'util.log', { message: 'a' })));
      await request(server).post(`${workflows()}/${archived}/archive`).set(auth()).expect(200);
      expect((await start(archived)).status).toBe(409);

      const hooked = await publish({
        schemaVersion: 1,
        nodes: [
          { key: 'hook', kind: 'TRIGGER', type: 'test.webhook', config: {} },
          action('log', 'util.log', { message: 'h' }),
        ],
        edges: [{ from: 'hook', to: 'log' }],
      });
      expect((await start(hooked)).status).toBe(409);
    });

    it('rejects oversized manual input', async () => {
      const wf = await publish(chain(action('log', 'util.log', { message: 'x' })));
      expect((await start(wf, { blob: 'x'.repeat(70_000) })).status).toBe(400);
    });
  });

  describe('with a worker', () => {
    beforeAll(async () => {
      worker = await createTestWorker(control);
    });

    it('executes queued runs, including those queued before the worker started (AC-07.2, AC-07.3, AC-08.1)', async () => {
      const id = await startRun(
        chain(
          action('a', 'util.log', { message: 'one' }),
          action('b', 'util.log', { message: 'two' }),
        ),
        { hello: 'world' },
      );
      const done = await settled(id);
      expect(done).toMatchObject({ status: 'SUCCEEDED', attemptCount: 1, lastErrorCategory: null });
      expect(done.startedAt).not.toBeNull();
      expect(done.completedAt).not.toBeNull();

      const rows = await steps(id);
      expect(rows.map((s) => [s.sequence, s.nodeKey, s.status, s.attemptCount])).toEqual([
        [1, 'trigger', 'SUCCEEDED', 1],
        [2, 'a', 'SUCCEEDED', 1],
        [3, 'b', 'SUCCEEDED', 1],
      ]);
      expect(rows[0].sanitizedOutput).toEqual({ hello: 'world' });
      expect(rows[2]).toMatchObject({
        sanitizedInput: { message: 'two' },
        sanitizedOutput: { message: 'two' },
      });
      expect(rows.every((s) => s.durationMs !== null && s.completedAt !== null)).toBe(true);

      // Runs queued in the API-only phase above were picked up too.
      const leftovers = await waitFor(
        async () => {
          const queued = await prisma.workflowRun.count({ where: { status: 'QUEUED' } });
          return queued === 0 ? true : undefined;
        },
        { what: 'earlier runs to drain' },
      );
      expect(leftovers).toBe(true);
    });

    it('retries a transient failure with backoff and resumes at the failed step (AC-07.4)', async () => {
      const id = await startRun(
        chain(
          action('before', 'test.sideEffect', { label: 'once' }),
          action('flaky', 'test.flaky', { failTimes: 2 }),
        ),
      );
      const done = await settled(id);
      expect(done).toMatchObject({ status: 'SUCCEEDED', attemptCount: 3 });
      const rows = await steps(id);
      expect(rows.find((s) => s.nodeKey === 'flaky')).toMatchObject({
        status: 'SUCCEEDED',
        attemptCount: 3,
        sanitizedOutput: { succeededAfter: 2 },
      });
      // The non-idempotent step before it ran exactly once despite three job attempts.
      expect(rows.find((s) => s.nodeKey === 'before')).toMatchObject({
        status: 'SUCCEEDED',
        attemptCount: 1,
      });
      expect(control.sideEffects.filter((c) => c.startsWith(`once@${id}`))).toHaveLength(1);
    });

    it('does not retry a permanent failure; downstream steps are skipped (AC-07.5, AC-08.3)', async () => {
      const id = await startRun(
        chain(
          action('boom', 'test.fail', { mode: 'permanent' }),
          action('after', 'util.log', { message: 'never' }),
        ),
      );
      const done = await settled(id);
      expect(done).toMatchObject({
        status: 'FAILED',
        attemptCount: 1,
        lastErrorCategory: 'PERMANENT_PROVIDER_ERROR',
        errorMessage: 'provider rejected the request',
      });
      expect(await stepStates(id)).toEqual({
        trigger: 'SUCCEEDED',
        boom: 'FAILED',
        after: 'SKIPPED',
      });

      const job = await api.get(RunQueue).queue.getJob(id);
      expect(job?.attemptsMade).toBe(1);
      expect(await job?.getState()).toBe('failed');
    });

    it('fails the run once retries are exhausted', async () => {
      const id = await startRun(chain(action('down', 'test.fail', { mode: 'retryable' })));
      const done = await settled(id);
      expect(done).toMatchObject({
        status: 'FAILED',
        attemptCount: 3,
        lastErrorCategory: 'TRANSIENT_INFRASTRUCTURE',
      });
      const step = (await steps(id)).find((s) => s.nodeKey === 'down');
      expect(step).toMatchObject({
        status: 'FAILED',
        attemptCount: 3,
        errorCategory: 'TRANSIENT_INFRASTRUCTURE',
      });
    });

    it('follows only the branch a condition chooses (AC-08.2)', async () => {
      const definition = {
        schemaVersion: 1,
        nodes: [
          trigger,
          { key: 'check', kind: 'CONDITION', type: 'test.branch', config: { result: true } },
          action('yes', 'util.log', { message: 'yes' }),
          action('yesToo', 'util.log', { message: 'yes 2' }),
          action('no', 'util.log', { message: 'no' }),
        ],
        edges: [
          { from: 'trigger', to: 'check' },
          { from: 'check', to: 'yes', branch: 'true' },
          { from: 'yes', to: 'yesToo' },
          { from: 'check', to: 'no', branch: 'false' },
        ] as Edge[],
      };
      const id = await startRun(definition);
      expect((await settled(id)).status).toBe('SUCCEEDED');
      expect(await stepStates(id)).toEqual({
        trigger: 'SUCCEEDED',
        check: 'SUCCEEDED',
        yes: 'SUCCEEDED',
        yesToo: 'SUCCEEDED',
        no: 'SKIPPED',
      });
      expect((await steps(id)).find((s) => s.nodeKey === 'check')?.sanitizedOutput).toEqual({
        result: true,
      });
    });

    it('passes outputs of earlier steps to later ones (AC-08.5)', async () => {
      const id = await startRun(
        chain(action('first', 'util.log', { message: 'from first' }), action('echo', 'test.echo')),
        { issue: 7 },
      );
      await settled(id);
      expect((await steps(id)).find((s) => s.nodeKey === 'echo')?.sanitizedOutput).toEqual({
        triggerInput: { issue: 7 },
        outputs: { trigger: { issue: 7 }, first: { message: 'from first' } },
      });
    });

    it('persists state at each transition while the run is in flight (AC-08.4)', async () => {
      const gate = control.hold();
      const id = await startRun(
        chain(
          action('a', 'util.log', { message: 'a' }),
          action('wait', 'test.wait'),
          action('c', 'util.log', { message: 'c' }),
        ),
      );
      await gate.entered;
      expect((await run(id)).status).toBe('RUNNING');
      expect(await stepStates(id)).toEqual({
        trigger: 'SUCCEEDED',
        a: 'SUCCEEDED',
        wait: 'RUNNING',
        c: 'PENDING',
      });
      gate.release();
      expect((await settled(id)).status).toBe('SUCCEEDED');
      expect(await stepStates(id)).toEqual({
        trigger: 'SUCCEEDED',
        a: 'SUCCEEDED',
        wait: 'SUCCEEDED',
        c: 'SUCCEEDED',
      });
    });

    it('stops before the next step when cancellation is requested', async () => {
      const gate = control.hold();
      const id = await startRun(
        chain(action('wait', 'test.wait'), action('next', 'util.log', { message: 'n' })),
      );
      await gate.entered;
      await prisma.workflowRun.update({ where: { id }, data: { cancelRequestedAt: new Date() } });
      gate.release();
      expect(await settled(id)).toMatchObject({
        status: 'CANCELLED',
        lastErrorCategory: 'CANCELLED',
      });
      expect(await stepStates(id)).toEqual({
        trigger: 'SUCCEEDED',
        wait: 'SUCCEEDED',
        next: 'SKIPPED',
      });
    });

    describe('conditions and data mapping (Part 11)', () => {
      /** trigger → classify (maps data) → check (condition) → alert (true) / quiet (false) */
      const triage = (condition: object) => ({
        schemaVersion: 1,
        nodes: [
          trigger,
          action('classify', 'util.log', { message: '{{ trigger.priority }}' }),
          { key: 'check', kind: 'CONDITION', type: 'condition', config: condition },
          action('alert', 'util.log', {
            message:
              'Issue #{{ trigger.issue.number }} "{{ trigger.issue.title }}" is {{ steps.classify.output.message }}',
          }),
          action('quiet', 'util.log', { message: 'nothing to do' }),
        ],
        edges: [
          { from: 'trigger', to: 'classify' },
          { from: 'classify', to: 'check' },
          { from: 'check', to: 'alert', branch: 'true' },
          { from: 'check', to: 'quiet', branch: 'false' },
        ] as Edge[],
      });
      const input = (priority: string, labels: string[], author = 'User') => ({
        priority,
        issue: { number: 7, title: 'Login fails', labels, author: { type: author } },
      });

      it('branches on trigger data (AC-11.1)', async () => {
        const definition = triage({
          all: [
            {
              left: { ref: 'trigger.issue.labels' },
              operator: 'contains',
              right: { value: 'production' },
            },
          ],
        });
        const yes = await startRun(definition, input('LOW', ['bug', 'production']));
        const no = await startRun(definition, input('LOW', ['bug']));
        await Promise.all([settled(yes), settled(no)]);
        expect(await stepStates(yes)).toMatchObject({
          check: 'SUCCEEDED',
          alert: 'SUCCEEDED',
          quiet: 'SKIPPED',
        });
        expect(await stepStates(no)).toMatchObject({ alert: 'SKIPPED', quiet: 'SUCCEEDED' });
      });

      it('branches on a previous step output with nested AND/OR/NOT (AC-11.2)', async () => {
        const definition = triage({
          all: [
            {
              left: { ref: 'steps.classify.output.message' },
              operator: 'equals',
              right: { value: 'HIGH' },
            },
            {
              any: [
                {
                  left: { ref: 'trigger.issue.labels' },
                  operator: 'contains',
                  right: { value: 'security' },
                },
                {
                  left: { ref: 'trigger.issue.labels' },
                  operator: 'contains',
                  right: { value: 'bug' },
                },
              ],
            },
            {
              not: {
                left: { ref: 'trigger.issue.author.type' },
                operator: 'equals',
                right: { value: 'Bot' },
              },
            },
          ],
        });
        const cases: [object, 'alert' | 'quiet'][] = [
          [input('HIGH', ['bug']), 'alert'],
          [input('HIGH', ['docs']), 'quiet'],
          [input('LOW', ['security']), 'quiet'],
          [input('HIGH', ['security'], 'Bot'), 'quiet'],
        ];
        for (const [payload, expected] of cases) {
          const id = await startRun(definition, payload);
          await settled(id);
          expect((await stepStates(id))[expected]).toBe('SUCCEEDED');
        }
      });

      it('maps earlier data into later steps', async () => {
        const id = await startRun(
          triage({ all: [{ left: { ref: 'trigger.priority' }, operator: 'exists' }] }),
          input('HIGH', []),
        );
        await settled(id);
        const alert = (await steps(id)).find((s) => s.nodeKey === 'alert');
        expect(alert?.sanitizedInput).toEqual({ message: 'Issue #7 "Login fails" is HIGH' });
        expect(alert?.sanitizedOutput).toEqual({ message: 'Issue #7 "Login fails" is HIGH' });
      });

      it('rejects invalid expressions at save and publish time (AC-11.3)', async () => {
        const wf = await request(server).post(workflows()).set(auth()).send({ name: 'bad refs' });
        const draft = await request(server)
          .put(`${workflows()}/${wf.body.id}/draft`)
          .set(auth())
          .send({
            expectedRevision: 0,
            definition: triage({
              all: [{ left: { ref: 'steps.alert.output.message' }, operator: 'exists' }],
            }),
          });
        expect(draft.body.issues.map((i: { code: string }) => i.code)).toEqual([
          'NON_ANCESTOR_REFERENCE',
        ]);

        const publishRes = await request(server)
          .post(`${workflows()}/${wf.body.id}/publish`)
          .set(auth())
          .send({ expectedRevision: 1 });
        expect(publishRes.status).toBe(422);

        const injected = await request(server)
          .post(`${workflows()}/${wf.body.id}/validate`)
          .set(auth())
          .send({
            definition: triage({
              all: [{ left: { ref: 'trigger.constructor.prototype' }, operator: 'exists' }],
            }),
          });
        expect(injected.body.issues.map((i: { code: string }) => i.code)).toContain(
          'INVALID_REFERENCE',
        );
      });
    });

    it('the sweeper re-enqueues a QUEUED run whose enqueue was lost (AC-07.8)', async () => {
      const wf = await publish(chain(action('log', 'util.log', { message: 'swept' })));
      const version = await prisma.workflow.findUniqueOrThrow({
        where: { id: wf },
        select: { activeVersionId: true },
      });
      // A run committed to the DB but never enqueued, as if Redis failed right after commit.
      const lost: WorkflowRun = await prisma.workflowRun.create({
        data: {
          workspaceId: ws,
          workflowId: wf,
          workflowVersionId: version.activeVersionId!,
          triggerSource: 'MANUAL',
          idempotencyKey: 'lost-enqueue',
          queuedAt: new Date(Date.now() - 120_000),
        },
      });
      expect(await api.get(RunQueue).queue.getJob(lost.id)).toBeUndefined();

      expect(await worker!.get(RunSweeper).sweep()).toBeGreaterThanOrEqual(1);
      expect((await settled(lost.id)).status).toBe('SUCCEEDED');
    });

    it('shuts down gracefully: the active job finishes before the worker closes (AC-07.7)', async () => {
      const gate = control.hold();
      const id = await startRun(chain(action('wait', 'test.wait')));
      await gate.entered;

      let closed = false;
      const closing = worker!.close().then(() => (closed = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(closed).toBe(false); // waiting for the active job
      gate.release();
      await closing;
      worker = undefined;

      expect((await run(id)).status).toBe('SUCCEEDED');
    });
  });
});
