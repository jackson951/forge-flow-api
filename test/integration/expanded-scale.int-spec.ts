import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppConfigService } from '../../src/config/app-config.service';
import { Env } from '../../src/config/env.schema';
import { GmailSyncService } from '../../src/execution/gmail-sync.service';
import { HttpPollRunner } from '../../src/execution/http-poll-runner';
import { WorkflowRunProcessor } from '../../src/execution/processors';
import { ScheduleEvaluator } from '../../src/execution/schedule-evaluator';
import { EgressClient } from '../../src/infrastructure/egress/egress-client';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { PollQueue } from '../../src/infrastructure/queue/poll-queue.service';
import { QueueBackpressure } from '../../src/infrastructure/queue/queue-backpressure.service';
import { RunQueue } from '../../src/infrastructure/queue/run-queue.service';
import { REDIS_CLIENT } from '../../src/infrastructure/redis/redis.module';
import { signJwt, webhookUrlParams } from '../../src/modules/integrations/jira/jira-webhook-auth';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { createTestApp } from '../support/create-app';
import { createTestWorker, waitFor } from '../support/create-worker';
import { FakeGoogle } from '../support/fake-google';
import { truncateAll } from '../support/test-database';
import { TestNodeControl } from '../support/test-node-types';

/**
 * Part 27 — expanded-platform scale and concurrency (real Postgres + Redis, 2 API instances,
 * several workers / evaluators / resolvers in-process). Each scenario has its pass/fail
 * threshold fixed here, before running. Volumes scale with FF_SCALE_* (defaults are moderate
 * for regular runs; the recorded measurements in docs/backend/27-… used larger values).
 * Measurements are printed as `SCALE_METRIC {...}` lines.
 */
const n = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const SCHEDULES = n('FF_SCALE_SCHEDULES', 1_000);
const HOOK_REQUESTS = n('FF_SCALE_HOOK_REQUESTS', 400);
const JIRA_REQUESTS = n('FF_SCALE_JIRA_REQUESTS', 200);
const HTTP_RUNS = n('FF_SCALE_HTTP_RUNS', 120);
const POLLS = n('FF_SCALE_POLLS', 100);
const GMAIL_WORKSPACES = n('FF_SCALE_GMAIL_WORKSPACES', 4);
const GMAIL_MESSAGES = n('FF_SCALE_GMAIL_MESSAGES', 40);
const SHUTDOWN_RUNS = n('FF_SCALE_SHUTDOWN_RUNS', 120);

// Thresholds (decided before running; FR-27.x)
const T = {
  scheduleLagP95Ms: 30_000, // FR-27.1
  hookAckP95Ms: 200, // FR-27.4 target (recorded; Part 21 exception context applies with workers busy)
  duplicates: 0, // AC-27.1
} as const;

const HOST = 'api.flowforge-test.example';
const JIRA_SECRET = ['scale', 'jira', 'client', 'secret', 'value'].join('-');
const fake = new FakeGoogle();

class ScaleConfig extends AppConfigService {
  override get<K extends keyof Env>(key: K): Env[K] {
    const overrides: Partial<Record<keyof Env, unknown>> = {
      WEBHOOK_HOOK_PER_IP_PER_MINUTE: 100_000, // all load comes from one IP here
      JIRA_CLIENT_ID: 'scale-jira-client',
      JIRA_CLIENT_SECRET: JIRA_SECRET,
      OAUTH_REDIRECT_BASE_URL: 'http://localhost:3000/api/v1/integrations',
      GOOGLE_CLIENT_ID: fake.clientId,
      GOOGLE_CLIENT_SECRET: fake.clientSecret,
      GOOGLE_AUTH_URL: `${fake.url}/authorize`,
      GOOGLE_TOKEN_URL: `${fake.url}/token`,
      GOOGLE_REVOKE_URL: `${fake.url}/revoke`,
      GOOGLE_USERINFO_URL: `${fake.url}/userinfo`,
      GOOGLE_JWKS_URL: `${fake.url}/certs`,
      GMAIL_API_URL: `${fake.url}/gmail/v1`,
      GMAIL_PUBSUB_TOPIC: fake.topic,
      GMAIL_PUSH_AUDIENCE: fake.audience,
      GMAIL_PUSH_SERVICE_ACCOUNT: fake.serviceAccount,
    };
    return (overrides[key] ?? super.get(key)) as Env[K];
  }
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const metric = (name: string, data: Record<string, unknown>) =>
  process.stdout.write(`SCALE_METRIC ${JSON.stringify({ scenario: name, ...data })}\n`);

/** Runs `tasks` with at most `limit` in flight. */
async function pool<T>(limit: number, tasks: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
}

jest.setTimeout(1_200_000);

describe('Expanded platform at scale (integration, Part 27)', () => {
  let api1: NestExpressApplication;
  let api2: NestExpressApplication;
  let worker1: TestingModule;
  let prisma: PrismaService;
  let redis: Redis;
  let user: RegisteredUser;
  let ws: string;
  let service: Server;
  let base: string;
  let redisBefore = 0;
  /** Local controllable test service: latency, 429s, items for polls; tracks concurrency. */
  const svc = {
    inFlight: 0,
    maxInFlight: 0,
    latencyMs: 0,
    rateLimitEvery: 0,
    limited: new Set<string>(),
    calls: 0,
    items: new Map<string, number>(),
  };
  const useFakes = (b: TestingModuleBuilder) =>
    b.overrideProvider(AppConfigService).useClass(ScaleConfig);
  const server = (i = 0): App => (i % 2 ? api2 : api1).getHttpServer();
  const auth = () => bearer(user.accessToken);
  const workflows = () => `/api/v1/workspaces/${ws}/workflows`;

  async function publish(
    nodes: object[],
    edges: object[],
    name = 'scale',
    api = 0,
  ): Promise<string> {
    const wf = await request(server(api)).post(workflows()).set(auth()).send({ name }).expect(201);
    const draft = await request(server(api))
      .put(`${workflows()}/${wf.body.id}/draft`)
      .set(auth())
      .send({ expectedRevision: 0, definition: { schemaVersion: 1, nodes, edges } })
      .expect(200);
    expect(draft.body.issues).toEqual([]);
    await request(server(api))
      .post(`${workflows()}/${wf.body.id}/publish`)
      .set(auth())
      .send({ expectedRevision: 1 })
      .expect(201);
    return wf.body.id;
  }

  const duplicateRuns = async (
    where: Prisma.WorkflowRunWhereInput,
    by: 'idempotencyKey' = 'idempotencyKey',
  ) => {
    const runs = await prisma.workflowRun.findMany({ where, select: { [by]: true } });
    return runs.length - new Set(runs.map((r) => r[by])).size;
  };
  const settledCount = (where: Prisma.WorkflowRunWhereInput) =>
    prisma.workflowRun.count({
      where: { ...where, status: { in: ['SUCCEEDED', 'FAILED', 'CANCELLED'] } },
    });

  beforeAll(async () => {
    service = createServer((req, res) => {
      svc.calls++;
      svc.inFlight++;
      svc.maxInFlight = Math.max(svc.maxInFlight, svc.inFlight);
      const done = () => {
        svc.inFlight--;
      };
      setTimeout(() => {
        // A real limit clears after Retry-After: a request (by `n`) is limited at most once.
        const n = new URL(req.url ?? '/', 'http://x').searchParams.get('n');
        if (
          svc.rateLimitEvery &&
          svc.calls % svc.rateLimitEvery === 0 &&
          !(n && svc.limited.has(n))
        ) {
          if (n) svc.limited.add(n);
          res.writeHead(429, { 'retry-after': '1' });
          res.end();
          return done();
        }
        const url = new URL(req.url ?? '/', 'http://x');
        res.setHeader('content-type', 'application/json');
        if (url.pathname.startsWith('/items/')) {
          const count = svc.items.get(url.pathname) ?? 0;
          res.end(
            JSON.stringify({
              data: Array.from({ length: count }, (_, i) => ({ id: `${url.pathname}-${i}` })),
            }),
          );
        } else res.end('{"ok":true}');
        done();
      }, svc.latencyMs);
    });
    await new Promise<void>((r) => service.listen(0, '127.0.0.1', r));
    const port = (service.address() as AddressInfo).port;
    base = `http://${HOST}:${port}`;
    await fake.start();

    api1 = await createTestApp(useFakes);
    api2 = await createTestApp(useFakes);
    prisma = api1.get(PrismaService);
    redis = api1.get<Redis>(REDIS_CLIENT);
    worker1 = await createTestWorker(new TestNodeControl(), useFakes);
    for (const m of [api1, api2, worker1])
      m.get(EgressClient).allowForTests('127.0.0.1', port, HOST);
    await truncateAll(prisma);
    user = await registerUser(api1.getHttpServer());
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: user.id } }))
      .workspaceId;
    redisBefore = Number(/used_memory:(\d+)/.exec(await redis.info('memory'))?.[1] ?? 0);
  });

  afterAll(async () => {
    await worker1?.close().catch(() => undefined);
    await api1
      .get(RunQueue)
      .queue.obliterate({ force: true })
      .catch(() => undefined);
    await api1
      .get(PollQueue)
      .queue.obliterate({ force: true })
      .catch(() => undefined);
    await api1.close();
    await api2.close();
    await new Promise((r) => service.close(r));
    await fake.stop();
  });

  it(`FR-27.1/27.2: ${SCHEDULES} schedules due at the same instant, 3 evaluators, retried ticks → one run each`, async () => {
    // A minute that has just passed, as a daily cron in each zone: the same instant everywhere,
    // and the next occurrence is a day away, so a long setup or drain never reaches another one.
    const occurrence = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
    const zones = ['UTC', 'Africa/Johannesburg', 'America/New_York'];
    const dailyAt = (timeZone: string) => {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: 'numeric',
        minute: 'numeric',
        hourCycle: 'h23',
      }).formatToParts(occurrence);
      const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
      return `${get('minute')} ${get('hour')} * * *`;
    };
    const def = {
      schemaVersion: 1,
      nodes: [
        {
          key: 'trigger',
          kind: 'TRIGGER',
          type: 'schedule.trigger',
          config: { schedule: { kind: 'interval', timezone: 'UTC', everyMinutes: 5 } },
        },
        { key: 'log', kind: 'ACTION', type: 'util.log', config: { message: 'tick' } },
      ],
      edges: [{ from: 'trigger', to: 'log' }],
    };
    const ids = Array.from({ length: SCHEDULES }, () => ({ wf: randomUUID(), v: randomUUID() }));
    for (let i = 0; i < ids.length; i += 1_000) {
      const chunk = ids.slice(i, i + 1_000);
      await prisma.workflow.createMany({
        data: chunk.map(({ wf }) => ({
          id: wf,
          workspaceId: ws,
          name: 'sched',
          status: 'PUBLISHED',
          draftDefinition: def,
        })),
      });
      await prisma.workflowVersion.createMany({
        data: chunk.map(({ wf, v }) => ({
          id: v,
          workspaceId: ws,
          workflowId: wf,
          version: 1,
          schemaVersion: 1,
          definition: def,
          definitionHash: 'h',
        })),
      });
      await prisma.$executeRaw`
        UPDATE "Workflow" w SET "activeVersionId" = v.id
        FROM "WorkflowVersion" v
        WHERE v."workflowId" = w.id AND w.id = ANY(${chunk.map((c) => c.wf)}::text[]::uuid[])`;
      await prisma.workflowSchedule.createMany({
        data: chunk.map(({ wf, v }, j) => ({
          workspaceId: ws,
          workflowId: wf,
          workflowVersionId: v,
          cron: dailyAt(zones[(i + j) % zones.length]),
          timezone: zones[(i + j) % zones.length],
          config: def.nodes[0].config,
          description: 'Daily',
          nextRunAt: occurrence,
          active: false, // all switched on together below
        })),
      });
    }
    const noEnqueue = { enqueue: async () => undefined } as unknown as RunQueue; // isolate scheduling
    const evaluator = async () =>
      new ScheduleEvaluator(
        prisma,
        noEnqueue,
        api1.get(QueueBackpressure),
        api1.get(AppConfigService),
        await api1.resolve(await import('nestjs-pino').then((m) => m.PinoLogger)),
        api1.get(PollQueue),
      );
    const evaluators = await Promise.all([evaluator(), evaluator(), evaluator()]);
    const drain = async () => {
      let fired = 0;
      let duplicates = 0;
      await Promise.all(
        evaluators.map(async (e) => {
          for (;;) {
            const r = await e.tick();
            fired += r.fired;
            duplicates += r.duplicates;
            if (!r.fired && !r.duplicates && !r.deactivated && !r.skipped) break;
          }
        }),
      );
      return { fired, duplicates };
    };
    await prisma.workflowSchedule.updateMany({
      where: { workspaceId: ws },
      data: { active: true },
    });
    const started = Date.now();
    const first = await drain();
    const elapsed = Date.now() - started;
    const where = { workspaceId: ws, triggerSource: 'SCHEDULE' as const };
    const runs = await prisma.workflowRun.findMany({
      where,
      select: { queuedAt: true, triggerInput: true },
    });
    // Lag from when the occurrence became due *for this test* (its schedules were created
    // after the occurrence instant).
    const lags = runs.map(
      (r) =>
        r.queuedAt.getTime() -
        Math.max(started, Date.parse((r.triggerInput as { scheduledFor: string }).scheduledFor)),
    );

    // Forced retries: every schedule back on the same occurrence (as if tick results were lost).
    await prisma.workflowSchedule.updateMany({
      where: { workspaceId: ws },
      data: { nextRunAt: occurrence },
    });
    const retry = await drain();
    const dup = await duplicateRuns(where);
    metric('schedules', {
      schedules: SCHEDULES,
      evaluators: 3,
      drainMs: elapsed,
      perSecond: Math.round((SCHEDULES / elapsed) * 1_000),
      lagP50Ms: percentile(lags, 50),
      lagP95Ms: percentile(lags, 95),
      retriedTick: retry,
      runs: runs.length,
      duplicateRuns: dup,
    });
    // The worker's own evaluator takes part too: the database is the judge.
    expect(first.fired).toBeLessThanOrEqual(SCHEDULES);
    expect(runs).toHaveLength(SCHEDULES);
    expect(retry.fired).toBe(0);
    expect(await prisma.workflowRun.count({ where })).toBe(SCHEDULES);
    expect(dup).toBe(T.duplicates);
    expect(percentile(lags, 95)).toBeLessThan(T.scheduleLagP95Ms);
    // Keep the sweeper off these synthetic runs (they were deliberately not enqueued).
    await prisma.workflowRun.updateMany({
      where,
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
    await prisma.workflowSchedule.updateMany({
      where: { workspaceId: ws },
      data: { active: false },
    });
  });

  // Intake measured with run execution paused: API instances, worker and k6-equivalent client
  // all share this one Node process, so executing runs would be measured as intake latency
  // (Part 21 recorded the same effect across containers). Runs execute after `resume()`.
  const pauseExecution = () => worker1.get(WorkflowRunProcessor).worker.pause(true);
  const resumeExecution = () => worker1.get(WorkflowRunProcessor).worker.resume();

  it(`FR-27.4: ${HOOK_REQUESTS} generic webhook deliveries over 2 APIs with concurrent duplicates`, async () => {
    await pauseExecution();
    const id = await publish(
      [
        {
          key: 'trigger',
          kind: 'TRIGGER',
          type: 'webhook.received',
          config: {
            verification: { mode: 'none', acknowledgeUnverified: true },
            deduplication: { source: 'header', header: 'Idempotency-Key' },
            rateLimitPerMinute: 600,
          },
        },
        { key: 'log', kind: 'ACTION', type: 'util.log', config: { message: 'hook' } },
      ],
      [{ from: 'trigger', to: 'log' }],
    );
    const { body: details } = await request(server())
      .get(`${workflows()}/${id}/webhook`)
      .set(auth())
      .expect(200);
    const unique = Math.round(HOOK_REQUESTS * 0.8);
    // 20 % of the keys are sent twice, at the same time, to different API instances.
    const keys = Array.from(
      { length: HOOK_REQUESTS },
      (_, i) => `k-${i < unique ? i : i - unique}`,
    );
    const latencies: number[] = [];
    let limited = 0;
    const started = Date.now();
    await pool(
      40,
      keys.map((key, i) => async () => {
        const t0 = Date.now();
        const res = await request(server(i))
          .post(details.path)
          .set({ 'content-type': 'application/json', 'idempotency-key': key })
          .send(JSON.stringify({ i }));
        latencies.push(Date.now() - t0);
        if (res.status === 429) limited++;
        else expect(res.status).toBe(202);
      }),
    );
    const elapsed = Date.now() - started;
    const runs = await prisma.workflowRun.count({ where: { workflowId: id } });
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { workflowId: id },
      select: { duplicateCount: true },
    });
    const dupCount = deliveries.reduce((s, d) => s + d.duplicateCount, 0);
    metric('generic-webhooks', {
      requests: HOOK_REQUESTS,
      apiInstances: 2,
      perSecond: Math.round((HOOK_REQUESTS / elapsed) * 1_000),
      ackP50Ms: percentile(latencies, 50),
      ackP95Ms: percentile(latencies, 95),
      ackP99Ms: percentile(latencies, 99),
      runs,
      deliveries: deliveries.length,
      duplicatesSuppressed: dupCount,
      rateLimited: limited,
      ackP95TargetMs: T.hookAckP95Ms,
      executionPaused: true,
    });
    // Per-hook limit 600/min: everything above it is answered 429 (never a duplicate run).
    expect(runs).toBe(deliveries.length);
    expect(runs + dupCount + limited).toBe(HOOK_REQUESTS);
    expect(runs).toBeLessThanOrEqual(unique);
  });

  it(`FR-27.4: ${JIRA_REQUESTS} Jira webhook deliveries over 2 APIs with retries`, async () => {
    await pauseExecution();
    const connection = await prisma.integrationConnection.create({
      data: {
        workspaceId: ws,
        provider: 'JIRA',
        externalAccountId: 'scale-account',
        accountLabel: 'scale',
        scopes: [],
        metadata: {
          sites: [{ cloudId: 'scale-site', name: 'scale', url: 'https://scale.atlassian.net' }],
        },
      },
    });
    const id = await publish(
      [
        {
          key: 'trigger',
          kind: 'TRIGGER',
          type: 'jira.issue.created',
          config: { connectionId: connection.id, siteId: 'scale-site', projectKeys: ['ENG'] },
        },
        {
          key: 'log',
          kind: 'ACTION',
          type: 'util.log',
          config: { message: '{{ trigger.issue.key }}' },
        },
      ],
      [{ from: 'trigger', to: 'log' }],
    );
    const query = new URLSearchParams(
      webhookUrlParams(JIRA_SECRET, connection.id, 'scale-site'),
    ).toString();
    const unique = Math.round(JIRA_REQUESTS * 0.8);
    const latencies: number[] = [];
    const started = Date.now();
    await pool(
      40,
      Array.from({ length: JIRA_REQUESTS }, (_, i) => async () => {
        const n = i < unique ? i : i - unique; // Atlassian retries of earlier deliveries
        const t0 = Date.now();
        const res = await request(server(i))
          .post(`/api/v1/webhooks/jira?${query}`)
          .set({
            'content-type': 'application/json',
            authorization: `Bearer ${signJwt(JIRA_SECRET, { exp: Math.floor(Date.now() / 1_000) + 300 })}`,
            'x-atlassian-webhook-identifier': `wh-${n}`,
          })
          .send(
            JSON.stringify({
              webhookEvent: 'jira:issue_created',
              timestamp: 1_000 + n,
              issue: {
                id: String(10_000 + n),
                key: `ENG-${n}`,
                fields: { project: { key: 'ENG' }, issuetype: { name: 'Bug' } },
              },
            }),
          );
        latencies.push(Date.now() - t0);
        expect([200, 202]).toContain(res.status);
      }),
    );
    const elapsed = Date.now() - started;
    const runs = await prisma.workflowRun.count({ where: { workflowId: id } });
    resumeExecution();
    metric('jira-webhooks', {
      requests: JIRA_REQUESTS,
      perSecond: Math.round((JIRA_REQUESTS / elapsed) * 1_000),
      ackP50Ms: percentile(latencies, 50),
      ackP95Ms: percentile(latencies, 95),
      runs,
      unique,
    });
    expect(runs).toBe(unique);
    expect(await duplicateRuns({ workflowId: id })).toBe(0);
  });

  it(`FR-27.3: ${HTTP_RUNS} http.request runs with latency and 429s; util.log runs are not starved`, async () => {
    svc.latencyMs = 200;
    svc.rateLimitEvery = 10;
    svc.maxInFlight = 0;
    const httpWf = await publish(
      [
        { key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger', config: {} },
        {
          key: 'call',
          kind: 'ACTION',
          type: 'http.request',
          config: { url: `${base}/slow?n={{trigger.n}}` },
        },
      ],
      [{ from: 'trigger', to: 'call' }],
    );
    const logWf = await publish(
      [
        { key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger', config: {} },
        { key: 'log', kind: 'ACTION', type: 'util.log', config: { message: 'fast' } },
      ],
      [{ from: 'trigger', to: 'log' }],
    );
    const logRuns = Math.max(20, Math.round(HTTP_RUNS / 4));
    const started = Date.now();
    await pool(
      20,
      [
        ...Array.from({ length: HTTP_RUNS }, () => httpWf),
        ...Array.from({ length: logRuns }, () => logWf),
      ].map(
        (wf, i) => () =>
          request(server(i))
            .post(`${workflows()}/${wf}/runs`)
            .set(auth())
            .send({ input: { n: i } })
            .expect(202),
      ),
    );
    await waitFor(
      async () => ((await settledCount({ workflowId: logWf })) === logRuns ? true : undefined),
      { timeoutMs: 300_000, what: 'util.log runs' },
    );
    const logDoneMs = Date.now() - started;
    await waitFor(
      async () => ((await settledCount({ workflowId: httpWf })) === HTTP_RUNS ? true : undefined),
      { timeoutMs: 600_000, intervalMs: 500, what: 'http runs' },
    );
    const httpDoneMs = Date.now() - started;
    const failed = await prisma.workflowRun.count({
      where: { workflowId: { in: [httpWf, logWf] }, status: { not: 'SUCCEEDED' } },
    });
    const providerLimit = api1.get(AppConfigService).queue.providerConcurrency;
    metric('http-action', {
      httpRuns: HTTP_RUNS,
      logRuns,
      latencyMs: 200,
      rateLimitEvery: 10,
      rateLimited: svc.limited.size,
      maxConcurrentAtService: svc.maxInFlight,
      providerConcurrencyPerWorker: providerLimit,
      workers: 1,
      logRunsDoneMs: logDoneMs,
      httpRunsDoneMs: httpDoneMs,
      notSucceeded: failed,
    });
    svc.latencyMs = 0;
    svc.rateLimitEvery = 0;
    expect(svc.limited.size).toBeGreaterThan(0); // 429 + Retry-After happened and was retried
    expect(failed).toBe(0);
    expect(svc.maxInFlight).toBeLessThanOrEqual(providerLimit);
    expect(logDoneMs).toBeLessThan(httpDoneMs); // other providers keep moving
  });

  it(`FR-27.6: ${POLLS} poll triggers, 3 concurrent pollers and a restart → one run per new item`, async () => {
    const pollDef = (i: number) => ({
      schemaVersion: 1,
      nodes: [
        {
          key: 'trigger',
          kind: 'TRIGGER',
          type: 'http.poll',
          config: {
            request: { url: `${base}/items/${i}` },
            schedule: { kind: 'interval', timezone: 'UTC', everyMinutes: 5 },
            items: { path: 'data' },
            identity: { path: 'id' },
          },
        },
        { key: 'log', kind: 'ACTION', type: 'util.log', config: { message: 'item' } },
      ],
      edges: [{ from: 'trigger', to: 'log' }],
    });
    const scheduleIds: string[] = [];
    for (let i = 0; i < POLLS; i++) {
      const wf = randomUUID();
      const v = randomUUID();
      await prisma.workflow.create({
        data: {
          id: wf,
          workspaceId: ws,
          name: 'poll',
          status: 'PUBLISHED',
          draftDefinition: pollDef(i),
        },
      });
      await prisma.workflowVersion.create({
        data: {
          id: v,
          workspaceId: ws,
          workflowId: wf,
          version: 1,
          schemaVersion: 1,
          definition: pollDef(i),
          definitionHash: 'h',
        },
      });
      await prisma.workflow.update({ where: { id: wf }, data: { activeVersionId: v } });
      const s = await prisma.workflowSchedule.create({
        data: {
          workspaceId: ws,
          workflowId: wf,
          workflowVersionId: v,
          kind: 'POLL',
          cron: '*/5 * * * *',
          timezone: 'UTC',
          config: {},
          description: 'poll',
          nextRunAt: new Date(Date.now() + 3_600_000),
        },
      });
      scheduleIds.push(s.id);
      svc.items.set(`/items/${i}`, 20);
    }
    const runner = worker1.get(HttpPollRunner);
    const occurrence = () => new Date().toISOString();
    await pool(
      10,
      scheduleIds.map((id) => () => runner.run({ scheduleId: id, occurrence: occurrence() })),
    ); // seed
    for (let i = 0; i < POLLS; i++) svc.items.set(`/items/${i}`, 30); // 10 new items each
    const started = Date.now();
    await pool(
      30,
      scheduleIds.flatMap((id) =>
        [0, 1, 2].map(() => () => runner.run({ scheduleId: id, occurrence: occurrence() })),
      ),
    );
    const elapsed = Date.now() - started;
    // "Restart": a fresh worker's runner polls again with the same state.
    const worker2 = await createTestWorker(new TestNodeControl(), useFakes);
    worker2.get(EgressClient).allowForTests('127.0.0.1', Number(new URL(base).port), HOST);
    await pool(
      10,
      scheduleIds.map(
        (id) => () => worker2.get(HttpPollRunner).run({ scheduleId: id, occurrence: occurrence() }),
      ),
    );
    await worker2.close();
    const where = { workspaceId: ws, triggerSource: 'POLL' as const };
    const runs = await prisma.workflowRun.count({ where });
    const states = await prisma.httpPollState.findMany({
      where: { workspaceId: ws },
      select: { seenIds: true },
    });
    const maxSeen = Math.max(...states.map((s) => (s.seenIds as string[]).length));
    metric('polls', {
      polls: POLLS,
      concurrentPollers: 3,
      pollPassMs: elapsed,
      runs,
      expectedRuns: POLLS * 10,
      duplicateRuns: await duplicateRuns(where),
      maxSeenIds: maxSeen,
    });
    expect(runs).toBe(POLLS * 10);
    expect(await duplicateRuns(where)).toBe(0);
    expect(maxSeen).toBeLessThanOrEqual(2_000);
  });

  it(`FR-27.5: Gmail storm — ${GMAIL_MESSAGES} messages, ${GMAIL_WORKSPACES} workspaces on one mailbox, pushes over 2 APIs`, async () => {
    const connectionIds: string[] = [];
    const workflowIds: string[] = [];
    for (let i = 0; i < GMAIL_WORKSPACES; i++) {
      const u = await registerUser(api1.getHttpServer());
      const wsId = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: u.id } }))
        .workspaceId;
      const start = await request(api1.getHttpServer())
        .post(`/api/v1/workspaces/${wsId}/integrations/GMAIL/connect`)
        .set(bearer(u.accessToken))
        .expect(201);
      const authorize = new URL(start.body.url);
      const code = fake.issueCode(authorize.searchParams.get('code_challenge')!);
      const done = await request(api1.getHttpServer())
        .get('/api/v1/integrations/gmail/callback')
        .query({ code, state: authorize.searchParams.get('state')! })
        .expect(302);
      const connectionId = new URL(done.headers.location).searchParams.get('connectionId')!;
      connectionIds.push(connectionId);
      const base2 = `/api/v1/workspaces/${wsId}/workflows`;
      const wf = await request(api1.getHttpServer())
        .post(base2)
        .set(bearer(u.accessToken))
        .send({ name: 'g' })
        .expect(201);
      await request(api1.getHttpServer())
        .put(`${base2}/${wf.body.id}/draft`)
        .set(bearer(u.accessToken))
        .send({
          expectedRevision: 0,
          definition: {
            schemaVersion: 1,
            nodes: [
              {
                key: 'trigger',
                kind: 'TRIGGER',
                type: 'gmail.email.received',
                config: { connectionId },
              },
              { key: 'log', kind: 'ACTION', type: 'util.log', config: { message: 'm' } },
            ],
            edges: [{ from: 'trigger', to: 'log' }],
          },
        })
        .expect(200);
      await request(api1.getHttpServer())
        .post(`${base2}/${wf.body.id}/publish`)
        .set(bearer(u.accessToken))
        .send({ expectedRevision: 1 })
        .expect(201);
      workflowIds.push(wf.body.id);
    }
    const sync = worker1.get(GmailSyncService);
    await sync.run();
    expect(await prisma.providerSubscription.count({ where: { provider: 'GMAIL' } })).toBe(
      GMAIL_WORKSPACES,
    );
    const resolveSpy = jest.spyOn(sync, 'resolve');
    for (let i = 0; i < GMAIL_MESSAGES; i++) fake.receive({ subject: `storm ${i}` });
    const started = Date.now();
    await pool(
      20,
      Array.from({ length: GMAIL_MESSAGES }, (_, i) => async () => {
        const p = fake.push();
        await request(server(i))
          .post('/api/v1/webhooks/gmail')
          .set({ authorization: p.authorization })
          .send(p.body)
          .expect(202);
      }),
    );
    const expected = GMAIL_MESSAGES * GMAIL_WORKSPACES;
    const where = { workflowId: { in: workflowIds } };
    await waitFor(
      async () => ((await prisma.workflowRun.count({ where })) >= expected ? true : undefined),
      { timeoutMs: 300_000, intervalMs: 500, what: 'Gmail runs' },
    );
    const elapsed = Date.now() - started;
    await new Promise((r) => setTimeout(r, 2_000)); // late resolutions must not add runs
    const runs = await prisma.workflowRun.count({ where });
    metric('gmail-storm', {
      messages: GMAIL_MESSAGES,
      workspaces: GMAIL_WORKSPACES,
      pushes: GMAIL_MESSAGES,
      resolutions: resolveSpy.mock.calls.length,
      runs,
      expectedRuns: expected,
      allRunsCreatedMs: elapsed,
      duplicateRuns: await duplicateRuns(where),
    });
    resolveSpy.mockRestore();
    expect(runs).toBe(expected);
    expect(await duplicateRuns(where)).toBe(0);
  });

  it(`FR-27.9: graceful worker shutdown during ${SHUTDOWN_RUNS} runs loses nothing`, async () => {
    svc.latencyMs = 100;
    const wf = await publish(
      [
        { key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger', config: {} },
        { key: 'call', kind: 'ACTION', type: 'http.request', config: { url: `${base}/slow` } },
      ],
      [{ from: 'trigger', to: 'call' }],
    );
    await pool(
      20,
      Array.from(
        { length: SHUTDOWN_RUNS },
        (_, i) => () =>
          request(server(i))
            .post(`${workflows()}/${wf}/runs`)
            .set(auth())
            .send({ input: {} })
            .expect(202),
      ),
    );
    await waitFor(
      async () =>
        (await settledCount({ workflowId: wf })) >= SHUTDOWN_RUNS / 4 ? true : undefined,
      { timeoutMs: 300_000, what: 'a quarter done' },
    );
    const t0 = Date.now();
    await worker1.close(); // graceful: in-flight jobs finish, nothing new is taken
    const stopMs = Date.now() - t0;
    const doneAtStop = await settledCount({ workflowId: wf });
    const running = await prisma.workflowRun.count({
      where: { workflowId: wf, status: 'RUNNING' },
    });
    const replacement = await createTestWorker(new TestNodeControl(), useFakes);
    replacement.get(EgressClient).allowForTests('127.0.0.1', Number(new URL(base).port), HOST);
    await waitFor(
      async () => ((await settledCount({ workflowId: wf })) === SHUTDOWN_RUNS ? true : undefined),
      { timeoutMs: 600_000, intervalMs: 500, what: 'all runs after restart' },
    );
    const notSucceeded = await prisma.workflowRun.count({
      where: { workflowId: wf, status: { not: 'SUCCEEDED' } },
    });
    const stepAttempts = await prisma.stepRun.aggregate({
      where: { run: { workflowId: wf }, nodeKey: 'call' },
      _max: { attemptCount: true },
    });
    metric('graceful-shutdown', {
      runs: SHUTDOWN_RUNS,
      settledAtStop: doneAtStop,
      runningAfterStop: running,
      gracefulStopMs: stopMs,
      notSucceeded,
      maxStepAttempts: stepAttempts._max.attemptCount,
    });
    await replacement.close();
    worker1 = undefined as unknown as TestingModule;
    svc.latencyMs = 0;
    expect(running).toBe(0); // nothing left half-done by the stopped worker
    expect(notSucceeded).toBe(0);
  });

  it('FR-27.7: Redis stays bounded (rate-limit keys expire, completed jobs are trimmed)', async () => {
    const used = Number(/used_memory:(\d+)/.exec(await redis.info('memory'))?.[1] ?? 0);
    const keys = await redis.keys('ff:hook-rl*');
    const ttls = await Promise.all(keys.slice(0, 200).map((k) => redis.ttl(k)));
    const queue = api1.get(RunQueue).queue;
    const counts = await queue.getJobCounts('completed', 'failed', 'waiting', 'delayed');
    metric('redis', {
      usedMemoryBeforeMb: +(redisBefore / 1_048_576).toFixed(1),
      usedMemoryAfterMb: +(used / 1_048_576).toFixed(1),
      rateLimitKeys: keys.length,
      keysWithoutTtl: ttls.filter((t) => t < 0).length,
      runQueue: counts,
    });
    expect(ttls.filter((t) => t < 0)).toEqual([]);
    expect(counts.completed).toBeLessThanOrEqual(1_000); // removeOnComplete count cap
  });
});
