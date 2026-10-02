import { NestExpressApplication } from '@nestjs/platform-express';
import { IntegrationProviderKey, RunStatus, StepStatus } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppConfigService } from '../../src/config/app-config.service';
import { RetentionService } from '../../src/execution/retention.service';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { bearer, registerUser } from '../support/auth';
import { createTestApp } from '../support/create-app';
import { createRun, createVersion, createWorkflow, createWorkspace } from '../support/factories';
import { truncateAll } from '../support/test-database';

const DAY = 24 * 3_600_000;
const NOW = new Date('2026-10-02T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

/**
 * Part 21, FR-21.8 / AC-21.4: retention deletes and trims expired history in batches, by age
 * and status only, across all workspaces alike.
 */
describe('Retention (integration)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const logged: string[] = [];
  const logger = {
    setContext: () => undefined,
    info: (_fields: unknown, message: string) => logged.push(message),
  } as unknown as PinoLogger;

  /** Small batches so that several are needed (the defaults are 1 000 × 50). */
  function retention(overrides: Partial<AppConfigService['retention']> = {}) {
    const config = {
      retention: {
        enabled: true,
        webhookDeliveryMs: 30 * DAY,
        stepPayloadMs: 30 * DAY,
        runMs: 90 * DAY,
        batchSize: 3,
        maxBatches: 50,
        intervalMs: 3_600_000,
        ...overrides,
      },
    } as AppConfigService;
    return new RetentionService(prisma, config, logger);
  }

  async function seedRun(
    version: { id: string; workflowId: string; workspaceId: string },
    createdAt: Date,
    status: RunStatus = RunStatus.SUCCEEDED,
    extra: { retryOfRunId?: string; webhookDeliveryId?: string } = {},
  ) {
    const run = await createRun(prisma, version, { createdAt, status, ...extra });
    await prisma.stepRun.createMany({
      data: ['trigger', 'log'].map((nodeKey, i) => ({
        runId: run.id,
        nodeKey,
        nodeType: i ? 'util.log' : 'manual.trigger',
        sequence: i + 1,
        status: StepStatus.SUCCEEDED,
        sanitizedInput: { message: `input of ${nodeKey}` },
        sanitizedOutput: { logged: `output of ${nodeKey}` },
        createdAt,
      })),
    });
    return run;
  }

  const delivery = (receivedAt: Date) =>
    prisma.webhookDelivery.create({
      data: {
        provider: IntegrationProviderKey.TEST,
        deliveryId: randomUUID(),
        eventType: 'issue.created',
        receivedAt,
      },
    });

  async function workspaceWithVersion() {
    const ws = await createWorkspace(prisma);
    const wf = await createWorkflow(prisma, ws.id);
    return createVersion(prisma, wf);
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    logged.length = 0;
  });

  afterAll(() => app.close());

  it('deletes expired deliveries and runs, trims old payloads, and keeps everything else (AC-21.4)', async () => {
    const [a, b] = [await workspaceWithVersion(), await workspaceWithVersion()];

    // Deliveries: 4 expired (two batches of 3), 1 recent.
    const oldDeliveries = await Promise.all([31, 40, 50, 60].map((d) => delivery(daysAgo(d))));
    const recentDelivery = await delivery(daysAgo(29));

    // Runs across two workspaces.
    const expired = await Promise.all([
      seedRun(a, daysAgo(91)),
      seedRun(a, daysAgo(120), RunStatus.FAILED),
      seedRun(b, daysAgo(100), RunStatus.CANCELLED),
      seedRun(b, daysAgo(95), RunStatus.SUCCEEDED, { webhookDeliveryId: oldDeliveries[0].id }),
    ]);
    const toTrim = await Promise.all([
      seedRun(a, daysAgo(31)),
      seedRun(a, daysAgo(60), RunStatus.FAILED),
      seedRun(b, daysAgo(89)),
      seedRun(b, daysAgo(45), RunStatus.CANCELLED),
    ]);
    const recent = await seedRun(a, daysAgo(29));
    // Never touched while unfinished, however old.
    const stuck = await seedRun(b, daysAgo(200), RunStatus.RUNNING);
    // A retry of an expired run survives it; only its link is cleared.
    const retry = await seedRun(a, daysAgo(10), RunStatus.SUCCEEDED, {
      retryOfRunId: expired[1].id,
    });

    const result = await retention().run(NOW);

    expect(result).toEqual({
      webhookDeliveriesDeleted: 4,
      runsTrimmed: 4,
      runsDeleted: 4,
      more: false,
    });
    expect(logged).toContain('Retention applied');

    const remainingDeliveries = await prisma.webhookDelivery.findMany({ select: { id: true } });
    expect(remainingDeliveries).toEqual([{ id: recentDelivery.id }]);

    const ids = (await prisma.workflowRun.findMany({ select: { id: true } })).map((r) => r.id);
    expect(ids.sort()).toEqual([...toTrim.map((r) => r.id), recent.id, stuck.id, retry.id].sort());
    expect(await prisma.stepRun.count({ where: { runId: { in: expired.map((r) => r.id) } } })).toBe(
      0,
    );
    expect(
      (await prisma.workflowRun.findUniqueOrThrow({ where: { id: retry.id } })).retryOfRunId,
    ).toBeNull();

    // Trimmed: payloads gone, everything else kept, run marked.
    for (const run of toTrim) {
      const row = await prisma.workflowRun.findUniqueOrThrow({
        where: { id: run.id },
        include: { steps: true },
      });
      expect(row.payloadsTrimmedAt).toEqual(NOW);
      expect(row.steps).toHaveLength(2);
      for (const step of row.steps) {
        expect(step).toMatchObject({
          sanitizedInput: null,
          sanitizedOutput: null,
          status: 'SUCCEEDED',
        });
      }
    }
    for (const run of [recent, stuck, retry]) {
      const row = await prisma.workflowRun.findUniqueOrThrow({
        where: { id: run.id },
        include: { steps: true },
      });
      expect(row.payloadsTrimmedAt).toBeNull();
      expect(row.steps.every((s) => s.sanitizedOutput !== null)).toBe(true);
    }

    // Idempotent: a second pass finds nothing.
    expect(await retention().run(NOW)).toEqual({
      webhookDeliveriesDeleted: 0,
      runsTrimmed: 0,
      runsDeleted: 0,
      more: false,
    });
  });

  it('stops after RETENTION_MAX_BATCHES and continues on the next tick', async () => {
    const version = await workspaceWithVersion();
    for (let i = 0; i < 7; i++) await seedRun(version, daysAgo(100 + i));

    const service = retention({ batchSize: 2, maxBatches: 2 });
    expect(await service.run(NOW)).toMatchObject({ runsDeleted: 4, more: true });
    expect(await prisma.workflowRun.count()).toBe(3);
    expect(await service.run(NOW)).toMatchObject({ runsDeleted: 3, more: false });
    expect(await prisma.workflowRun.count()).toBe(0);
  });

  it('a trimmed run can still be retried from the start, but not resumed', async () => {
    const server = app.getHttpServer();
    const user = await registerUser(server);
    const workspaceId = (
      await prisma.workspaceMember.findFirstOrThrow({ where: { userId: user.id } })
    ).workspaceId;
    const wf = await createWorkflow(prisma, workspaceId);
    const version = await createVersion(prisma, wf);
    await prisma.workflow.update({
      where: { id: wf.id },
      data: { status: 'PUBLISHED', activeVersionId: version.id },
    });
    const failed = await seedRun(version, daysAgo(40), RunStatus.FAILED);
    await retention().run(NOW);

    const detail = await request(server)
      .get(`/api/v1/workspaces/${workspaceId}/runs/${failed.id}`)
      .set(bearer(user.accessToken))
      .expect(200);
    expect(detail.body.payloadsTrimmedAt).toBe(NOW.toISOString());

    const retryUrl = `/api/v1/workspaces/${workspaceId}/runs/${failed.id}/retry`;
    const resume = await request(server)
      .post(retryUrl)
      .set(bearer(user.accessToken))
      .send({ resumeFromFailedStep: true })
      .expect(409);
    expect(resume.body.details).toEqual({ code: 'PAYLOADS_TRIMMED' });

    await request(server).post(retryUrl).set(bearer(user.accessToken)).send({}).expect(202);
  });
});
