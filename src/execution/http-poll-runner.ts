import { Injectable } from '@nestjs/common';
import { PollStatus, Prisma, ScheduleKind, TriggerSource, WorkflowStatus } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';
import { parseDefinition } from '../engine/definition/definition.schema';
import { ExecutionError } from '../engine/errors';
import { EgressClient } from '../infrastructure/egress/egress-client';
import {
  describeUrl,
  EgressBlockedError,
  hostAllowed,
} from '../infrastructure/egress/egress-policy';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { ExecutePollJobData } from '../infrastructure/queue/queue.constants';
import { RunQueue } from '../infrastructure/queue/run-queue.service';
import { applyAuth } from '../modules/integrations/http/http-auth';
import {
  backoffMs,
  cursorFrom,
  extractItems,
  newItems,
  pollConfigHash,
  PollDataError,
  rememberIds,
} from '../modules/integrations/http/http-poll';
import {
  buildBody,
  classifyStatus,
  classifyTransportError,
  resolveRequestUrl,
  scrubSecrets,
} from '../modules/integrations/http/http-request';
import {
  HTTP_POLL,
  httpPollConfigSchema,
  HttpPollConfig,
} from '../modules/integrations/http/http.node-types';
import { WorkerConnections } from './worker-connections';

/**
 * A poll writes up to maxItemsPerPoll runs in one transaction; Prisma's 5 s default aborted it on
 * a contended database (Part 27). Nothing commits on abort, so the next occurrence retries.
 */
const POLL_TX = { maxWait: 10_000, timeout: 30_000 };

export type PollOutcome =
  | { kind: 'not-live' | 'backing-off' }
  | { kind: 'seeded'; items: number }
  | { kind: 'polled'; fired: number; newItems: number }
  | { kind: 'failed'; category: string };

/** Trigger input of a run started by a poll: built by the system from the item. */
export interface PollTriggerInput {
  triggerType: 'POLL';
  item: unknown;
  itemId: string;
  polledAt: string;
  scheduleId: string;
}

/**
 * Runs one http.poll occurrence (Part 24, FR-24.16) in the worker:
 *
 *   live check → request through the egress guard → items → new ones (seen window) →
 *   [tx: lock state → runs (unique key poll:<workflow>:<item>) → state] → enqueue
 *
 * "Exactly one run per new item" does not rely on the seen window: the run idempotency key
 * is unique per workspace, so concurrent pollers, retried jobs and restarts cannot repeat an
 * item (until retention deletes its run). Failures never throw: they are counted on the state,
 * mark it FAILING from the 3rd in a row and back off; the next occurrence tries again.
 */
@Injectable()
export class HttpPollRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly egress: EgressClient,
    private readonly connections: WorkerConnections,
    private readonly runs: RunQueue,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(HttpPollRunner.name);
  }

  async run(job: ExecutePollJobData): Promise<PollOutcome> {
    const schedule = await this.prisma.workflowSchedule.findUnique({
      where: { id: job.scheduleId },
      include: {
        workflow: { select: { status: true, activeVersionId: true } },
        version: { select: { definition: true } },
      },
    });
    if (
      !schedule ||
      schedule.kind !== ScheduleKind.POLL ||
      !schedule.active ||
      schedule.workflow.status !== WorkflowStatus.PUBLISHED ||
      schedule.workflow.activeVersionId !== schedule.workflowVersionId
    ) {
      return { kind: 'not-live' };
    }
    const ids = {
      scheduleId: schedule.id,
      workflowId: schedule.workflowId,
      workspaceId: schedule.workspaceId,
    };

    const config = this.triggerConfig(schedule.version.definition);
    if (!config) {
      this.logger.warn(ids, 'Poll skipped: the trigger configuration is no longer valid');
      return { kind: 'not-live' };
    }
    const configHash = pollConfigHash(config);
    let state = await this.prisma.httpPollState.upsert({
      where: { workflowId: schedule.workflowId },
      create: { workspaceId: schedule.workspaceId, workflowId: schedule.workflowId, configHash },
      update: {},
    });
    if (state.configHash !== configHash) {
      // New request or item settings: what was seen before means nothing now.
      state = await this.prisma.httpPollState.update({
        where: { id: state.id },
        data: {
          configHash,
          seeded: false,
          seenIds: [],
          lastCursor: null,
          consecutiveFailures: 0,
          status: PollStatus.OK,
          nextAttemptAt: null,
          lastError: null,
        },
      });
    }
    if (state.nextAttemptAt && state.nextAttemptAt.getTime() > Date.now()) {
      return { kind: 'backing-off' };
    }

    const polledAt = new Date();
    let body: unknown;
    try {
      body = await this.request(config, schedule.workspaceId, state.lastCursor, ids);
    } catch (err) {
      return this.fail(state.id, state.consecutiveFailures, err, polledAt, ids);
    }

    let found: { id: string; item: unknown }[];
    let cursor: string | undefined;
    try {
      found = newItems(
        extractItems(body, config.items.path),
        state.seenIds as string[],
        config.identity.path,
      );
      cursor = cursorFrom(body, config.cursor?.responsePath);
    } catch (err) {
      return this.fail(state.id, state.consecutiveFailures, err, polledAt, ids);
    }

    const { fired, seeded, runIds } = await this.prisma.$transaction(async (tx) => {
      // Serialises pollers of one workflow on the state row; the unique run key is the backstop.
      await tx.$queryRaw`SELECT id FROM "HttpPollState" WHERE id = ${state.id}::uuid FOR UPDATE`;
      const locked = await tx.httpPollState.findUniqueOrThrow({ where: { id: state.id } });
      const seen = new Set(locked.seenIds as string[]);
      const fresh = found.filter((f) => !seen.has(f.id));
      const seedOnly = !locked.seeded && config.seedOnFirstPoll;
      const batch = seedOnly ? [] : fresh.slice(0, config.maxItemsPerPoll);

      // Still the active version? (the workflow may have been archived meanwhile)
      const workflow = await tx.workflow.findUniqueOrThrow({
        where: { id: schedule.workflowId },
        select: { status: true, activeVersionId: true },
      });
      const live =
        workflow.status === WorkflowStatus.PUBLISHED &&
        workflow.activeVersionId === schedule.workflowVersionId;

      let inserted: string[] = [];
      if (live && batch.length) {
        const rows = batch.map(({ id, item }) => {
          const triggerInput: PollTriggerInput = {
            triggerType: 'POLL',
            item,
            itemId: id,
            polledAt: polledAt.toISOString(),
            scheduleId: schedule.id,
          };
          return {
            id: randomUUID(),
            workspaceId: schedule.workspaceId,
            workflowId: schedule.workflowId,
            workflowVersionId: schedule.workflowVersionId,
            triggerSource: TriggerSource.POLL,
            idempotencyKey: `poll:${schedule.workflowId}:${id}`,
            triggerInput: triggerInput as unknown as Prisma.InputJsonObject,
            correlationId: randomUUID(),
          };
        });
        // ON CONFLICT DO NOTHING: an item another poller already turned into a run.
        await tx.workflowRun.createMany({ data: rows, skipDuplicates: true });
        const existing = await tx.workflowRun.findMany({
          where: { id: { in: rows.map((r) => r.id) } },
          select: { id: true },
        });
        inserted = existing.map((r) => r.id);
      }

      // Seeding remembers everything; otherwise only what was handled (the rest comes next time).
      const remembered = seedOnly ? fresh.map((f) => f.id) : batch.map((f) => f.id);
      await tx.httpPollState.update({
        where: { id: locked.id },
        data: {
          seeded: true,
          seenIds: rememberIds(locked.seenIds as string[], remembered),
          lastCursor: cursor ?? locked.lastCursor,
          lastPolledAt: polledAt,
          lastSuccessAt: polledAt,
          lastError: null,
          consecutiveFailures: 0,
          nextAttemptAt: null,
          status: PollStatus.OK,
          itemsFired: { increment: inserted.length },
        },
      });
      return { fired: inserted.length, seeded: seedOnly, runIds: inserted };
    }, POLL_TX);

    for (const runId of runIds) {
      await this.runs
        .enqueue(runId, { reason: 'poll', ...ids })
        .catch((err: Error) =>
          this.logger.warn(
            { runId, error: err.message },
            'Enqueue failed; the sweeper will pick the run up',
          ),
        );
    }
    this.logger.info(
      { ...ids, occurrence: job.occurrence, newItems: found.length, fired, seeded },
      seeded ? 'Poll seeded (no runs on the first poll)' : 'Poll completed',
    );
    return seeded
      ? { kind: 'seeded', items: found.length }
      : { kind: 'polled', fired, newItems: found.length };
  }

  /** The request through the egress guard; returns the parsed JSON body. */
  private async request(
    config: HttpPollConfig,
    workspaceId: string,
    lastCursor: string | null,
    ids: Record<string, string>,
  ): Promise<unknown> {
    const connection = config.connectionId
      ? await this.connections.httpConnection(workspaceId, config.connectionId)
      : undefined;
    const meta = connection?.metadata;
    let url = resolveRequestUrl(config.request.url, meta?.baseUrl);
    for (const [k, v] of Object.entries(config.request.query)) url.searchParams.append(k, v);
    if (config.cursor && lastCursor) url.searchParams.set(config.cursor.queryParam, lastCursor);

    const body = buildBody(config.request.body as never);
    let headers: Record<string, string> = Object.fromEntries(
      Object.entries(config.request.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    headers.accept ??= 'application/json';
    headers['user-agent'] ??= 'FlowForge/1.0';
    if (body.contentType) headers['content-type'] ??= body.contentType;
    let sensitiveHeaders: string[] = [];
    if (connection && meta) {
      const applied = applyAuth(meta, connection.secrets, url, headers);
      url = applied.url;
      headers = applied.headers;
      sensitiveHeaders = applied.sensitiveHeaders;
    }

    let res;
    try {
      res = await this.egress.send({
        method: config.request.method,
        url: url.toString(),
        headers,
        body: body.data,
        timeoutMs: config.request.timeoutMs,
        maxRedirects: 3,
        maxResponseBytes: this.config.http.maxResponseBytes,
        sensitiveHeaders,
        checkHop: (hop) => {
          if (meta && !hostAllowed(hop.hostname.replace(/^\[|\]$/g, ''), meta.allowedHosts)) {
            throw new EgressBlockedError("host is not in the connection's allowed hosts");
          }
        },
      });
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        this.logger.warn(
          { ...ids, egressBlocked: true, url: describeUrl(url) },
          'Poll blocked by the egress guard',
        );
      }
      throw classifyTransportError(err, true);
    }
    const failure = classifyStatus(res, { idempotent: true, failOn4xx: true });
    if (failure) throw failure;
    if (res.truncated) throw new PollDataError('The response is larger than the read limit');
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body.toString('utf8')) as unknown;
    } catch {
      throw new PollDataError('The response is not valid JSON');
    }
    // Items become stored run input: the connection's own secrets never travel with them.
    return scrubSecrets(parsed, Object.values(connection?.secrets ?? {}));
  }

  private async fail(
    stateId: string,
    previousFailures: number,
    err: unknown,
    polledAt: Date,
    ids: Record<string, string>,
  ): Promise<PollOutcome> {
    const category =
      err instanceof ExecutionError
        ? err.category
        : err instanceof PollDataError
          ? 'POLL_DATA'
          : 'INTERNAL';
    const message =
      err instanceof ExecutionError || err instanceof PollDataError
        ? err.message
        : 'Internal error';
    const failures = previousFailures + 1;
    const wait = backoffMs(failures);
    await this.prisma.httpPollState.update({
      where: { id: stateId },
      data: {
        consecutiveFailures: failures,
        lastPolledAt: polledAt,
        lastError: message.slice(0, 500),
        status: failures >= 3 ? PollStatus.FAILING : PollStatus.OK,
        nextAttemptAt: wait ? new Date(Date.now() + wait) : null,
      },
    });
    this.logger.warn({ ...ids, category, failures, backoffMs: wait }, 'Poll failed');
    return { kind: 'failed', category };
  }

  private triggerConfig(definition: Prisma.JsonValue): HttpPollConfig | null {
    const parsed = parseDefinition(definition);
    if (!parsed.ok) return null;
    const trigger = parsed.definition.nodes.find(
      (n) => n.kind === 'TRIGGER' && n.type === HTTP_POLL,
    );
    if (!trigger) return null;
    const result = httpPollConfigSchema(
      this.config.http.policy,
      this.config.schedule.minIntervalMinutes,
    ).safeParse(trigger.config);
    return result.success ? result.data : null;
  }
}
