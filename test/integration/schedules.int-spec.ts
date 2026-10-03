import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppConfigService } from '../../src/config/app-config.service';
import { PrismaRunStore } from '../../src/execution/prisma-run-store';
import { RunSweeper } from '../../src/execution/processors';
import { occurrenceKey, ScheduleEvaluator } from '../../src/execution/schedule-evaluator';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { QueueBackpressure } from '../../src/infrastructure/queue/queue-backpressure.service';
import { JOBS, QUEUES } from '../../src/infrastructure/queue/queue.constants';
import { RunQueue } from '../../src/infrastructure/queue/run-queue.service';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { captureLogs, expectNoSecrets } from '../support/canaries';
import { createTestApp } from '../support/create-app';
import { createTestWorker, waitFor } from '../support/create-worker';
import { truncateAll } from '../support/test-database';
import { TestNodeControl } from '../support/test-node-types';

const MINUTE = 60_000;
const floorTo = (ms: number, d = new Date()) => new Date(Math.floor(d.getTime() / ms) * ms);

type Schedule = Record<string, unknown>;
const every5: Schedule = { kind: 'interval', timezone: 'UTC', everyMinutes: 5 };
const scheduled = (schedule: Schedule, message = 'at {{ trigger.scheduledFor }}') => ({
  schemaVersion: 1,
  nodes: [
    { key: 'trigger', kind: 'TRIGGER', type: 'schedule.trigger', config: { schedule } },
    { key: 'log', kind: 'ACTION', type: 'util.log', config: { message } },
  ],
  edges: [{ from: 'trigger', to: 'log' }],
});
const manual = {
  schemaVersion: 1,
  nodes: [
    { key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger', config: {} },
    { key: 'log', kind: 'ACTION', type: 'util.log', config: { message: 'manual' } },
  ],
  edges: [{ from: 'trigger', to: 'log' }],
};

/**
 * Part 23 — schedule trigger, against real Postgres and Redis: schedule lifecycle on
 * publish/archive/delete (AC-23.2), one run per occurrence under concurrency (AC-23.3),
 * end-to-end through the worker (AC-23.4), misfire and sweeper recovery (AC-23.5), logs
 * (AC-23.6).
 */
describe('Schedule trigger (integration)', () => {
  let api: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let worker: TestingModule | undefined;
  let user: RegisteredUser;
  let ws: string;
  const logs = captureLogs();

  const auth = () => bearer(user.accessToken);
  const workflows = () => `/api/v1/workspaces/${ws}/workflows`;

  async function evaluator(queue?: RunQueue): Promise<ScheduleEvaluator> {
    return new ScheduleEvaluator(
      prisma,
      queue ?? api.get(RunQueue),
      api.get(QueueBackpressure),
      api.get(AppConfigService),
      await api.resolve(PinoLogger),
    );
  }

  async function saveAndPublish(workflowId: string, definition: object) {
    const current = await request(server)
      .get(`${workflows()}/${workflowId}`)
      .set(auth())
      .expect(200);
    const draft = await request(server)
      .put(`${workflows()}/${workflowId}/draft`)
      .set(auth())
      .send({ expectedRevision: current.body.draftRevision, definition })
      .expect(200);
    expect(draft.body.issues).toEqual([]);
    await request(server)
      .post(`${workflows()}/${workflowId}/publish`)
      .set(auth())
      .send({ expectedRevision: draft.body.draftRevision })
      .expect(201);
  }

  async function publish(definition: object): Promise<string> {
    const wf = await request(server)
      .post(workflows())
      .set(auth())
      .send({ name: 'sched' })
      .expect(201);
    await saveAndPublish(wf.body.id, definition);
    return wf.body.id;
  }

  const scheduleOf = (workflowId: string) =>
    prisma.workflowSchedule.findUniqueOrThrow({ where: { workflowId } });
  /** Pretends the occurrence at `at` is due (as if time had passed). */
  const makeDue = (workflowId: string, at: Date) =>
    prisma.workflowSchedule.update({ where: { workflowId }, data: { nextRunAt: at } });
  const runsOf = (workflowId: string) =>
    prisma.workflowRun.findMany({ where: { workflowId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    api = await createTestApp();
    server = api.getHttpServer();
    prisma = api.get(PrismaService);
    await truncateAll(prisma);
    user = await registerUser(server);
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: user.id } }))
      .workspaceId;
  });

  afterAll(async () => {
    await worker?.close();
    await api.get(RunQueue).queue.obliterate({ force: true });
    await api.close();
    jest.restoreAllMocks();
  });

  describe('validation and lifecycle (FR-23.1–23.5, AC-23.2)', () => {
    it('lists schedule.trigger and reports invalid schedules on the draft', async () => {
      const types = await request(server).get('/api/v1/node-types').set(auth()).expect(200);
      expect(types.body).toContainEqual({
        type: 'schedule.trigger',
        kind: 'TRIGGER',
        displayName: 'Schedule',
        available: true,
      });

      const wf = await request(server)
        .post(workflows())
        .set(auth())
        .send({ name: 'bad' })
        .expect(201);
      const draft = await request(server)
        .put(`${workflows()}/${wf.body.id}/draft`)
        .set(auth())
        .send({
          expectedRevision: 0,
          definition: scheduled({ kind: 'daily', timezone: 'Mars/Olympus', time: '07:00' }),
        })
        .expect(200);
      expect(draft.body.issues).toEqual([
        expect.objectContaining({
          code: 'INVALID_NODE_CONFIG',
          nodeKey: 'trigger',
          message: expect.stringContaining('IANA timezone'),
        }),
      ]);
      await request(server)
        .post(`${workflows()}/${wf.body.id}/publish`)
        .set(auth())
        .send({ expectedRevision: draft.body.draftRevision })
        .expect(422);
      expect(await prisma.workflowSchedule.count({ where: { workflowId: wf.body.id } })).toBe(0);
    });

    it('publish creates the schedule; the workflow shows a read-only summary', async () => {
      const before = Date.now();
      const id = await publish(
        scheduled({ kind: 'weekdays', timezone: 'Africa/Johannesburg', time: '07:00' }),
      );
      const schedule = await scheduleOf(id);
      const version = await prisma.workflowVersion.findFirstOrThrow({ where: { workflowId: id } });
      expect(schedule).toMatchObject({
        workspaceId: ws,
        workflowVersionId: version.id,
        cron: '0 7 * * 1-5',
        timezone: 'Africa/Johannesburg',
        description: 'Weekdays at 07:00 (Africa/Johannesburg)',
        active: true,
        lastOccurrenceAt: null,
      });
      expect(schedule.nextRunAt!.getTime()).toBeGreaterThan(before);
      // 07:00 SAST = 05:00 UTC
      expect(schedule.nextRunAt!.toISOString()).toMatch(/T05:00:00\.000Z$/);

      const detail = await request(server).get(`${workflows()}/${id}`).set(auth()).expect(200);
      expect(detail.body.schedule).toEqual({
        active: true,
        timezone: 'Africa/Johannesburg',
        description: 'Weekdays at 07:00 (Africa/Johannesburg)',
        nextRunAt: schedule.nextRunAt!.toISOString(),
        lastOccurrenceAt: null,
        lastRunId: null,
      });
      const list = await request(server).get(workflows()).set(auth()).expect(200);
      expect(list.body.items.find((w: { id: string }) => w.id === id).schedule.active).toBe(true);
    });

    it('a new version replaces the schedule atomically; a manual version removes it', async () => {
      const id = await publish(scheduled({ kind: 'daily', timezone: 'UTC', time: '07:00' }));
      const first = await scheduleOf(id);

      await saveAndPublish(
        id,
        scheduled({ kind: 'hourly', timezone: 'Europe/London', minute: 15 }),
      );
      const second = await scheduleOf(id);
      expect(second.id).toBe(first.id);
      expect(second.workflowVersionId).not.toBe(first.workflowVersionId);
      expect(second).toMatchObject({ cron: '15 * * * *', timezone: 'Europe/London', active: true });
      expect(second.nextRunAt!.getTime() - Date.now()).toBeLessThanOrEqual(60 * MINUTE);

      await saveAndPublish(id, manual);
      expect(await prisma.workflowSchedule.count({ where: { workflowId: id } })).toBe(0);
      const detail = await request(server).get(`${workflows()}/${id}`).set(auth()).expect(200);
      expect(detail.body.schedule).toBeNull();
    });

    it('archive stops the schedule; unarchive resumes from now without backfill; delete removes it', async () => {
      const id = await publish(scheduled(every5));
      await request(server).post(`${workflows()}/${id}/archive`).set(auth()).expect(200);
      expect(await scheduleOf(id)).toMatchObject({ active: false, nextRunAt: null });
      expect(await (await evaluator()).tick()).toMatchObject({ fired: 0 });

      await request(server).post(`${workflows()}/${id}/unarchive`).set(auth()).expect(200);
      const resumed = await scheduleOf(id);
      expect(resumed.active).toBe(true);
      expect(resumed.nextRunAt!.getTime()).toBeGreaterThan(Date.now());

      // Delete (no runs yet): the schedule goes with the workflow.
      await request(server).delete(`${workflows()}/${id}`).set(auth()).expect(204);
      expect(await prisma.workflowSchedule.count({ where: { workflowId: id } })).toBe(0);
    });

    it('a schedule that no longer matches a published workflow never runs (FR-23.10)', async () => {
      const id = await publish(scheduled(every5));
      // Simulate inconsistent state: archived, but the schedule row still active and due.
      await prisma.workflow.update({ where: { id }, data: { status: 'ARCHIVED' } });
      await makeDue(id, floorTo(5 * MINUTE));
      expect(await (await evaluator()).tick()).toMatchObject({ fired: 0, deactivated: 1 });
      expect(await runsOf(id)).toEqual([]);
      expect(await scheduleOf(id)).toMatchObject({ active: false, nextRunAt: null });
    });
  });

  describe('turning occurrences into runs (FR-23.6, AC-23.3)', () => {
    it('a due occurrence becomes exactly one QUEUED, enqueued run with system trigger metadata', async () => {
      const id = await publish(scheduled(every5));
      const occurrence = floorTo(5 * MINUTE);
      await makeDue(id, occurrence);

      const result = await (await evaluator()).tick();
      expect(result.fired).toBe(1);
      const schedule = await scheduleOf(id);
      const [run] = await runsOf(id);
      const fired = schedule.lastOccurrenceAt!;
      expect(fired.getTime()).toBeGreaterThanOrEqual(occurrence.getTime());
      expect(run).toMatchObject({
        workspaceId: ws,
        workflowVersionId: schedule.workflowVersionId,
        status: 'QUEUED',
        triggerSource: 'SCHEDULE',
        idempotencyKey: occurrenceKey(schedule.id, fired),
        correlationId: expect.any(String),
        triggerInput: {
          triggerType: 'SCHEDULE',
          scheduledFor: fired.toISOString(),
          triggeredAt: expect.any(String),
          timezone: 'UTC',
          scheduleId: schedule.id,
        },
      });
      expect(schedule.lastRunId).toBe(run.id);
      expect(schedule.nextRunAt!.getTime()).toBe(fired.getTime() + 5 * MINUTE);
      expect(await api.get(RunQueue).queue.getJob(run.id)).toBeDefined();

      // Filterable as a scheduled run.
      const listed = await request(server)
        .get(`/api/v1/workspaces/${ws}/runs?triggerSource=SCHEDULE&workflowId=${id}`)
        .set(auth())
        .expect(200);
      expect(listed.body.items.map((r: { id: string }) => r.id)).toEqual([run.id]);
    });

    it('evaluators racing on the same due schedules create one run per occurrence', async () => {
      const ids = await Promise.all(Array.from({ length: 6 }, () => publish(scheduled(every5))));
      const occurrence = floorTo(5 * MINUTE);
      await Promise.all(ids.map((id) => makeDue(id, occurrence)));

      const evaluators = await Promise.all([evaluator(), evaluator(), evaluator()]);
      const results = await Promise.all(evaluators.map((e) => e.tick()));
      expect(results.reduce((n, r) => n + r.fired, 0)).toBe(6);
      for (const id of ids) expect(await runsOf(id)).toHaveLength(1);
    });

    it('a retried tick for an occurrence that already has a run is suppressed by the database', async () => {
      const id = await publish(scheduled(every5));
      const occurrence = floorTo(5 * MINUTE);
      await makeDue(id, occurrence);
      await (await evaluator()).tick();
      const fired = (await scheduleOf(id)).lastOccurrenceAt!;

      // As if the tick ran again for the same occurrence (e.g. state rolled back elsewhere).
      await makeDue(id, fired);
      const again = await (await evaluator()).tick();
      expect(again).toMatchObject({ fired: 0, duplicates: 1 });
      expect(await runsOf(id)).toHaveLength(1);
      expect((await scheduleOf(id)).nextRunAt!.getTime()).toBe(fired.getTime() + 5 * MINUTE);
      expect(
        logs.some(([, m]) => m === 'Schedule occurrence already has a run; duplicate suppressed'),
      ).toBe(true);
    });

    it('manual "Run now" works and cannot pose as a scheduled run (FR-23.9)', async () => {
      const id = await publish(scheduled(every5));
      const res = await request(server)
        .post(`${workflows()}/${id}/runs`)
        .set(auth())
        .send({ input: { triggerType: 'SCHEDULE', scheduledFor: '2020-01-01T00:00:00.000Z' } })
        .expect(202);
      const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: res.body.runId } });
      expect(run.triggerSource).toBe('MANUAL');
      expect(run.triggerInput).toEqual({
        triggerType: 'MANUAL',
        scheduledFor: null,
        triggeredAt: expect.any(String),
        timezone: 'UTC',
        scheduleId: null,
        input: { triggerType: 'SCHEDULE', scheduledFor: '2020-01-01T00:00:00.000Z' },
      });
    });

    it('schedules are scoped to their workspace', async () => {
      const id = await publish(scheduled(every5));
      const other = await registerUser(server);
      const otherWs = (
        await prisma.workspaceMember.findFirstOrThrow({ where: { userId: other.id } })
      ).workspaceId;
      await request(server)
        .get(`/api/v1/workspaces/${otherWs}/workflows/${id}`)
        .set(bearer(other.accessToken))
        .expect(404);
      const list = await request(server)
        .get(`/api/v1/workspaces/${otherWs}/workflows`)
        .set(bearer(other.accessToken))
        .expect(200);
      expect(list.body.items).toEqual([]);
    });
  });

  describe('misfires and recovery (FR-23.7, AC-23.5)', () => {
    it('after downtime within the grace window only the latest occurrence runs', async () => {
      const id = await publish(scheduled(every5));
      const latest = floorTo(5 * MINUTE);
      await makeDue(id, new Date(latest.getTime() - 30 * MINUTE));
      const result = await (await evaluator()).tick();
      expect(result).toMatchObject({ fired: 1 });
      expect(result.skipped).toBeGreaterThanOrEqual(6);
      const runs = await runsOf(id);
      expect(runs).toHaveLength(1);
      expect((runs[0].triggerInput as { scheduledFor: string }).scheduledFor).toBe(
        (await scheduleOf(id)).lastOccurrenceAt!.toISOString(),
      );
    });

    it('an occurrence older than the grace window is skipped, not run late', async () => {
      const twoHoursAgo = floorTo(MINUTE, new Date(Date.now() - 120 * MINUTE));
      const time = twoHoursAgo.toISOString().slice(11, 16);
      const id = await publish(scheduled({ kind: 'daily', timezone: 'UTC', time }));
      await makeDue(id, twoHoursAgo);
      const result = await (await evaluator()).tick();
      expect(result).toMatchObject({ fired: 0 });
      expect(result.skipped).toBeGreaterThanOrEqual(1);
      expect(await runsOf(id)).toEqual([]);
      expect((await scheduleOf(id)).nextRunAt!.getTime()).toBe(
        twoHoursAgo.getTime() + 24 * 60 * MINUTE,
      );
    });

    it('a run whose enqueue failed stays QUEUED and the sweeper enqueues it', async () => {
      const id = await publish(scheduled(every5));
      await makeDue(id, floorTo(5 * MINUTE));
      const broken = {
        enqueue: async () => {
          throw new Error('redis unavailable');
        },
      } as unknown as RunQueue;
      expect(await (await evaluator(broken)).tick()).toMatchObject({ fired: 1 });
      const [run] = await runsOf(id);
      expect(run.status).toBe('QUEUED');
      expect(await api.get(RunQueue).queue.getJob(run.id)).toBeUndefined();

      await prisma.workflowRun.update({
        where: { id: run.id },
        data: { queuedAt: new Date(Date.now() - 10 * MINUTE) },
      });
      const sweeper = new RunSweeper(
        new PrismaRunStore(prisma),
        api.get(RunQueue),
        api.get(AppConfigService),
        await api.resolve(PinoLogger),
      );
      await sweeper.sweep();
      expect(await api.get(RunQueue).queue.getJob(run.id)).toBeDefined();
    });
  });

  describe('logs (AC-23.6)', () => {
    it('a fired occurrence is logged with its ids and times, and no secrets', async () => {
      const id = await publish(scheduled(every5));
      await makeDue(id, floorTo(5 * MINUTE));
      logs.length = 0;
      await (await evaluator()).tick();
      const fired = logs.find(([, message]) => message === 'Schedule occurrence fired');
      expect(fired?.[0]).toEqual({
        scheduleId: expect.any(String),
        workflowId: id,
        workspaceId: ws,
        runId: expect.any(String),
        correlationId: expect.any(String),
        scheduledFor: expect.any(String),
        lagMs: expect.any(Number),
        enqueuedAt: expect.any(String),
        workerId: expect.any(String),
      });
      expectNoSecrets(logs, [
        process.env.JWT_ACCESS_SECRET!,
        process.env.JWT_REFRESH_SECRET!,
        process.env.AI_API_KEY!,
        user.accessToken,
      ]);
    });
  });

  describe('end to end through the worker (AC-23.4, S23.1)', () => {
    it('a scheduled occurrence runs through queue, worker and engine to SUCCEEDED', async () => {
      worker = await createTestWorker(new TestNodeControl());
      const id = await publish(scheduled(every5));
      await makeDue(id, floorTo(5 * MINUTE));
      // A tick of the worker's own maintenance job (instead of waiting up to 30 s for the next).
      await worker.get<Queue>(getQueueToken(QUEUES.MAINTENANCE)).add(JOBS.EVALUATE_SCHEDULES, {});

      const run = await waitFor(
        async () => {
          const [r] = await runsOf(id);
          return r && ['SUCCEEDED', 'FAILED'].includes(r.status) ? r : undefined;
        },
        { timeoutMs: 30_000, what: 'the scheduled run to finish' },
      );
      expect(run).toMatchObject({ status: 'SUCCEEDED', triggerSource: 'SCHEDULE' });
      const scheduledFor = (run.triggerInput as { scheduledFor: string }).scheduledFor;
      const steps = await prisma.stepRun.findMany({
        where: { runId: run.id },
        orderBy: { sequence: 'asc' },
      });
      expect(steps.map((s) => [s.nodeKey, s.status])).toEqual([
        ['trigger', 'SUCCEEDED'],
        ['log', 'SUCCEEDED'],
      ]);
      expect(steps[0].sanitizedOutput).toMatchObject({ triggerType: 'SCHEDULE', scheduledFor });
      expect(steps[1].sanitizedOutput).toEqual({ message: `at ${scheduledFor}` });
    });
  });
});
