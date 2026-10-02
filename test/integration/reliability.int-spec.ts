// Must be first: short job locks and step timeouts for the crash and timeout scenarios.
import '../support/reliability-env';
import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule } from '@nestjs/testing';
import { Prisma, RunStatus, StepRun } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { NodeTypeCatalog } from '../../src/engine/catalog/node-type-catalog';
import { PrismaRunStore } from '../../src/execution/prisma-run-store';
import { RunSweeper, WorkflowRunProcessor } from '../../src/execution/processors';
import { RunWorkerService } from '../../src/execution/run-worker.service';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RunQueue } from '../../src/infrastructure/queue/run-queue.service';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { createTestApp } from '../support/create-app';
import { createTestWorker, waitFor } from '../support/create-worker';
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

/**
 * Part 15 — delivery guarantees, one test per scenario (S1–S8). FlowForge is at-least-once
 * with deduplication at every boundary that has a key, and at-most-once-after-uncertainty
 * for non-idempotent side effects.
 */
describe('Reliability scenarios (Part 15)', () => {
  let api: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let worker: TestingModule;
  let admin: RegisteredUser;
  let member: RegisteredUser;
  let ws: string;
  const control = new TestNodeControl();
  const extraWorkers: TestingModule[] = [];

  const auth = (user = admin) => bearer(user.accessToken);
  const workflowsUrl = () => `/api/v1/workspaces/${ws}/workflows`;

  async function publish(definition: object): Promise<string> {
    const wf = await request(server).post(workflowsUrl()).set(auth()).send({ name: 'wf' });
    const draft = await request(server)
      .put(`${workflowsUrl()}/${wf.body.id}/draft`)
      .set(auth())
      .send({ expectedRevision: 0, definition });
    expect(draft.body.issues).toEqual([]);
    await request(server)
      .post(`${workflowsUrl()}/${wf.body.id}/publish`)
      .set(auth())
      .send({ expectedRevision: 1 })
      .expect(201);
    return wf.body.id;
  }

  async function start(workflowId: string, input: object = {}): Promise<string> {
    const res = await request(server)
      .post(`${workflowsUrl()}/${workflowId}/runs`)
      .set(auth())
      .send({ input })
      .expect(202);
    return res.body.runId;
  }

  const run = (id: string) => prisma.workflowRun.findUniqueOrThrow({ where: { id } });
  const steps = async (runId: string) =>
    Object.fromEntries(
      (await prisma.stepRun.findMany({ where: { runId } })).map((s: StepRun) => [s.nodeKey, s]),
    );
  const settled = (id: string, timeoutMs = 20_000) =>
    waitFor(
      async () => {
        const r = await run(id);
        return (['SUCCEEDED', 'FAILED', 'CANCELLED'] as RunStatus[]).includes(r.status)
          ? r
          : undefined;
      },
      { what: `run ${id} to finish`, timeoutMs },
    );
  /** Side-effect calls recorded for one run (labels are `${label}@${runId}:${nodeKey}`). */
  const effectsOf = (runId: string) => control.sideEffects.filter((e) => e.includes(`@${runId}:`));

  const SECRET = process.env.WEBHOOK_TEST_SECRET!;
  function webhook(body: object, deliveryId: string) {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex');
    return request(server)
      .post('/api/v1/webhooks/test')
      .set({
        'content-type': 'application/json',
        'x-flowforge-delivery': deliveryId,
        'x-flowforge-event': 'issue.created',
        'x-flowforge-timestamp': String(ts),
        'x-flowforge-signature': `sha256=${sig}`,
      })
      .send(raw);
  }

  beforeAll(async () => {
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
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    for (const w of [worker, ...extraWorkers]) await w.close().catch(() => undefined);
    await api.get(RunQueue).queue.obliterate({ force: true });
    await api.close();
  });

  it('S1: the same webhook delivered twice (and 10× concurrently) starts one run', async () => {
    const workflowId = await publish({
      schemaVersion: 1,
      nodes: [
        {
          key: 'hook',
          kind: 'TRIGGER',
          type: 'test.event',
          config: { event: 'issue.created', resource: 's1' },
        },
        action('fx', 'test.sideEffect', { label: 's1' }),
      ],
      edges: [{ from: 'hook', to: 'fx' }],
    });
    const sequential = randomUUID();
    expect((await webhook({ resource: 's1', data: {} }, sequential)).status).toBe(202);
    const again = await webhook({ resource: 's1', data: {} }, sequential);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true });

    const concurrent = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => webhook({ resource: 's1', data: {} }, concurrent)),
    );
    expect(responses.filter((r) => r.status === 202)).toHaveLength(1);

    const runs = await prisma.workflowRun.findMany({ where: { workflowId } });
    expect(runs).toHaveLength(2);
    for (const r of runs) {
      await settled(r.id);
      expect(effectsOf(r.id)).toHaveLength(1);
    }
  });

  it('S2: the same run processed by three workers at once executes each side effect once', async () => {
    // Runs are created but not enqueued, so only the three racing workers below process them.
    jest.spyOn(api.get(RunQueue), 'enqueue').mockResolvedValue();
    const workflowId = await publish(
      chain(
        action('a', 'test.sideEffect', { label: 's2a' }),
        action('b', 'test.sideEffect', { label: 's2b' }),
      ),
    );
    const runIds = await Promise.all(Array.from({ length: 5 }, () => start(workflowId)));
    const service = worker.get(RunWorkerService);
    const job = (n: number) => ({ jobId: `dup-${n}`, attemptsMade: 0, maxAttempts: 3 });

    for (const runId of runIds) {
      await Promise.allSettled([0, 1, 2].map((n) => service.process(runId, job(n))));
      const r = await run(runId);
      // Exactly-once is not claimed: an overlap may end UNCERTAIN, but never duplicates.
      expect(['SUCCEEDED', 'FAILED']).toContain(r.status);
      const effects = effectsOf(runId);
      expect(effects.filter((e) => e.startsWith('s2a@'))).toHaveLength(1);
      expect(effects.filter((e) => e.startsWith('s2b@')).length).toBeLessThanOrEqual(1);
      if (r.status === 'SUCCEEDED') expect(effects).toHaveLength(2);
      else expect(r.lastErrorCategory).toBe('UNCERTAIN_OUTCOME');
    }
  });

  describe('S4: provider timeouts', () => {
    let uncertainRunId: string;

    it('a timeout of a non-idempotent step is UNCERTAIN_OUTCOME and never retried', async () => {
      const gate = control.hold();
      const workflowId = await publish(
        chain(action('notify', 'test.slowSideEffect', { label: 's4' })),
      );
      uncertainRunId = await start(workflowId);
      await gate.entered;
      const r = await settled(uncertainRunId);
      gate.release();

      expect(r.status).toBe('FAILED');
      expect(r.lastErrorCategory).toBe('UNCERTAIN_OUTCOME');
      expect((await steps(uncertainRunId)).notify).toMatchObject({
        status: 'FAILED',
        errorCategory: 'UNCERTAIN_OUTCOME',
        attemptCount: 1,
      });
      expect(effectsOf(uncertainRunId)).toHaveLength(1);
    });

    it('a timeout of an idempotent step is retried', async () => {
      const gate = control.hold();
      const workflowId = await publish(chain(action('wait', 'test.wait')));
      const runId = await start(workflowId);
      await waitFor(
        async () => ((await steps(runId)).wait?.status === 'RETRYING' ? true : undefined),
        { what: 'first attempt to time out' },
      );
      gate.release();
      const r = await settled(runId);
      expect(r.status).toBe('SUCCEEDED');
      expect((await steps(runId)).wait.attemptCount).toBe(2);
    });

    describe('S6: manual retry', () => {
      let workflowId: string;
      let failedRunId: string;

      beforeAll(async () => {
        workflowId = await publish(
          chain(
            action('pay', 'test.sideEffect', { label: 's6' }),
            action('fail', 'test.fail', { mode: 'permanent' }),
          ),
        );
        failedRunId = await start(workflowId, { order: 42 });
        expect((await settled(failedRunId)).status).toBe('FAILED');
        expect(effectsOf(failedRunId)).toHaveLength(1);
      });

      const retry = (runId: string, body: object = {}, user = admin, headers: object = {}) =>
        request(server)
          .post(`/api/v1/workspaces/${ws}/runs/${runId}/retry`)
          .set({ ...auth(user), ...headers })
          .send(body);

      it('is ADMIN-only and only for FAILED runs', async () => {
        expect((await retry(failedRunId, {}, member)).status).toBe(403);
        const ok = await publish(chain(action('log', 'util.log', { message: 'ok' })));
        const succeeded = await start(ok);
        await settled(succeeded);
        const res = await retry(succeeded);
        expect(res.status).toBe(409);
        expect(res.body.message).toBe('Only failed runs can be retried');
        expect((await retry(randomUUID())).status).toBe(404);
      });

      it('creates a new run on the same version with the same input (repeats completed steps)', async () => {
        // A newer version exists; the retry must still use the failed run's version.
        await request(server)
          .put(`${workflowsUrl()}/${workflowId}/draft`)
          .set(auth())
          .send({
            expectedRevision: 1,
            definition: chain(action('pay', 'test.sideEffect', { label: 's6-v2' })),
          })
          .expect(200);
        await request(server)
          .post(`${workflowsUrl()}/${workflowId}/publish`)
          .set(auth())
          .send({ expectedRevision: 2 })
          .expect(201);

        const res = await retry(failedRunId);
        expect(res.status).toBe(202);
        expect(res.body).toEqual({
          runId: expect.any(String),
          status: 'QUEUED',
          retryOfRunId: failedRunId,
          reusedSteps: [],
        });
        const original = await run(failedRunId);
        const retried = await settled(res.body.runId);
        expect(retried).toMatchObject({
          triggerSource: 'RETRY',
          retryOfRunId: failedRunId,
          workflowVersionId: original.workflowVersionId,
          triggerInput: { order: 42 },
          status: 'FAILED',
        });
        expect(retried.idempotencyKey).not.toBe(original.idempotencyKey);
        expect(effectsOf(res.body.runId)).toEqual([`s6@${res.body.runId}:pay`]);
      });

      it('resumeFromFailedStep reuses succeeded steps, so completed side effects are not repeated', async () => {
        const res = await retry(failedRunId, { resumeFromFailedStep: true });
        expect(res.status).toBe(202);
        expect(res.body.reusedSteps.sort()).toEqual(['pay', 'start']);
        const retried = await settled(res.body.runId);
        expect(retried.status).toBe('FAILED'); // the failing step ran again
        expect(effectsOf(res.body.runId)).toEqual([]);
        const s = await steps(res.body.runId);
        expect(s.pay).toMatchObject({ status: 'SUCCEEDED', sanitizedOutput: { sent: true } });
        expect(s.fail).toMatchObject({ status: 'FAILED', attemptCount: 1 });
        const audit = await prisma.auditEvent.findFirstOrThrow({
          where: { action: 'run.retried', targetId: res.body.runId },
        });
        expect(audit.metadata).toMatchObject({
          retryOfRunId: failedRunId,
          resumeFromFailedStep: true,
        });
      });

      it('the same Idempotency-Key returns the same retry', async () => {
        const headers = { 'Idempotency-Key': `retry-${randomUUID()}` };
        const a = await retry(failedRunId, {}, admin, headers);
        const b = await retry(failedRunId, {}, admin, headers);
        expect(a.status).toBe(202);
        expect(b.body.runId).toBe(a.body.runId);
      });

      it('after an UNCERTAIN_OUTCOME the retry must be acknowledged explicitly', async () => {
        const refused = await retry(uncertainRunId);
        expect(refused.status).toBe(409);
        expect(refused.body.details).toEqual({ code: 'UNCERTAIN_OUTCOME', nodeKeys: ['notify'] });

        control.hold().release(); // let the retried step through
        const accepted = await retry(uncertainRunId, { acknowledgeUncertainOutcome: true });
        expect(accepted.status).toBe(202);
        expect((await settled(accepted.body.runId)).status).toBe('SUCCEEDED');
        // The human-approved retry is the only way the side effect happens again.
        expect(effectsOf(accepted.body.runId)).toHaveLength(1);
      });
    });
  });

  it('S7: a failed enqueue leaves the run QUEUED; the sweeper recovers it', async () => {
    const workflowId = await publish(chain(action('fx', 'test.sideEffect', { label: 's7' })));
    jest.spyOn(api.get(RunQueue), 'enqueue').mockRejectedValueOnce(new Error('Redis unavailable'));
    const runId = await start(workflowId); // still 202: the run is committed before enqueueing
    await new Promise((r) => setTimeout(r, 300));
    expect((await run(runId)).status).toBe('QUEUED');

    await prisma.workflowRun.update({
      where: { id: runId },
      data: { queuedAt: new Date(Date.now() - 10 * 60_000) },
    });
    expect(await worker.get(RunSweeper).sweep()).toBeGreaterThanOrEqual(1);
    expect((await settled(runId)).status).toBe('SUCCEEDED');
    expect(effectsOf(runId)).toHaveLength(1);
  });

  it('S8: a transient database error before the step marker is retried; the provider is called once', async () => {
    const store = worker.get(PrismaRunStore);
    const original = store.startStep.bind(store);
    let failed = false;
    jest.spyOn(store, 'startStep').mockImplementation(async (runId, nodeKey, input, claim) => {
      if (nodeKey === 'fx' && !failed) {
        failed = true;
        throw new Prisma.PrismaClientKnownRequestError("Can't reach database server", {
          code: 'P1001',
          clientVersion: Prisma.prismaVersion.client,
        });
      }
      return original(runId, nodeKey, input, claim);
    });
    const workflowId = await publish(chain(action('fx', 'test.sideEffect', { label: 's8' })));
    const runId = await start(workflowId);

    const r = await settled(runId);
    expect(failed).toBe(true);
    expect(r.status).toBe('SUCCEEDED');
    expect(r.attemptCount).toBe(2); // job retried
    expect((await steps(runId)).fx.attemptCount).toBe(1); // the first marker never persisted
    expect(effectsOf(runId)).toHaveLength(1);
  });

  describe('S3 / S5: a worker dies mid-step (hard kill) and the job is redelivered', () => {
    let current: TestingModule;

    beforeAll(async () => {
      await worker.close(); // from here on, only the workers below consume jobs
      current = await createTestWorker(control);
      extraWorkers.push(current);
    });

    /** Stops a worker abruptly: no graceful drain, its job lock is no longer renewed. */
    async function hardKill(w: TestingModule) {
      await w.get(WorkflowRunProcessor).worker.close(true);
    }

    it('S3: side effect done, crash before it was recorded → UNCERTAIN_OUTCOME, no resend', async () => {
      const gate = control.hold();
      const workflowId = await publish(
        chain(action('notify', 'test.slowSideEffect', { label: 's3' })),
      );
      const runId = await start(workflowId);
      await gate.entered; // the provider call has happened
      await hardKill(current);

      const takeover = await createTestWorker(control);
      extraWorkers.push(takeover);
      const r = await settled(runId, 25_000);
      expect(r.status).toBe('FAILED');
      expect(r.lastErrorCategory).toBe('UNCERTAIN_OUTCOME');
      // Decided by the new worker's redelivery rule (not by a timeout of the killed one).
      expect((await steps(runId)).notify).toMatchObject({
        status: 'FAILED',
        errorCategory: 'UNCERTAIN_OUTCOME',
        errorMessage: expect.stringMatching(
          /^The previous attempt stopped while this step was running/,
        ),
      });
      expect(effectsOf(runId)).toHaveLength(1);

      // The killed worker's handler now returns; it has lost the run and changes nothing.
      gate.release();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await run(runId)).toMatchObject({
        status: 'FAILED',
        lastErrorCategory: 'UNCERTAIN_OUTCOME',
      });
      expect((await steps(runId)).notify.status).toBe('FAILED');
      expect(effectsOf(runId)).toHaveLength(1);
      current = takeover;
    });

    it('S5: an idempotent step left RUNNING is re-executed and the run completes', async () => {
      const gate = control.hold();
      const workflowId = await publish(
        chain(action('wait', 'test.wait'), action('after', 'test.sideEffect', { label: 's5' })),
      );
      const runId = await start(workflowId);
      await gate.entered;
      await hardKill(current);

      const takeover = await createTestWorker(control);
      extraWorkers.push(takeover);
      await waitFor(async () => ((await run(runId)).attemptCount >= 2 ? true : undefined), {
        what: 'redelivery to the new worker',
        timeoutMs: 25_000,
      });
      gate.release(); // both the dead worker's and the new worker's handler finish

      const r = await settled(runId);
      expect(r.status).toBe('SUCCEEDED');
      expect((await steps(runId)).wait.status).toBe('SUCCEEDED');
      expect(effectsOf(runId)).toHaveLength(1); // the step after it ran once
      current = takeover;
    });
  });
});
