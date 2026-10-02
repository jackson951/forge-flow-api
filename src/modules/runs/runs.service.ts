import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RunStatus, StepStatus } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import { redactSecrets } from '../../common/security/redaction';
import { describeError } from '../../engine/error-categories';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RunQueue } from '../../infrastructure/queue/run-queue.service';
import { AuditService } from '../audit/audit.service';
import { ListRunsQueryDto } from './dto/list-runs-query.dto';

const RUN_SUMMARY_SELECT = {
  id: true,
  workflowId: true,
  workflow: { select: { name: true } },
  version: { select: { version: true } },
  status: true,
  triggerSource: true,
  attemptCount: true,
  lastErrorCategory: true,
  errorMessage: true,
  retryOfRunId: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
} satisfies Prisma.WorkflowRunSelect;

type RunSummaryRow = Prisma.WorkflowRunGetPayload<{ select: typeof RUN_SUMMARY_SELECT }>;

const TERMINAL: RunStatus[] = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED];

/** Opaque keyset cursor over (createdAt, id): stable while new runs are inserted. */
export const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString('base64url');

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const date = new Date(createdAt);
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(date.getTime())) {
      throw new Error('bad cursor');
    }
    return { createdAt: date, id };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

const durationMs = (startedAt: Date | null, completedAt: Date | null) =>
  startedAt && completedAt ? completedAt.getTime() - startedAt.getTime() : null;

function summary(run: RunSummaryRow) {
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflow.name,
    version: run.version.version,
    status: run.status,
    triggerSource: run.triggerSource,
    attemptCount: run.attemptCount,
    error: describeError(run.lastErrorCategory, run.errorMessage),
    retryOfRunId: run.retryOfRunId,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: durationMs(run.startedAt, run.completedAt),
  };
}

/**
 * Run history (Part 16). Everything is workspace-scoped; stored data is sanitised at write
 * time and redacted again on read (trigger input is stored as received, because later steps
 * need it, so secrets typed into a manual run are hidden here). History is independent of
 * the workflow's current state: archiving or republishing never removes runs.
 */
@Injectable()
export class RunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: RunQueue,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RunsService.name);
  }

  async list(workspaceId: string, query: ListRunsQueryDto) {
    const limit = query.limit ?? 20;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.prisma.workflowRun.findMany({
      where: {
        workspaceId,
        ...(query.workflowId && { workflowId: query.workflowId }),
        ...(query.status && { status: query.status }),
        ...(query.triggerSource && { triggerSource: query.triggerSource }),
        ...((query.from || query.to) && {
          createdAt: {
            ...(query.from && { gte: new Date(query.from) }),
            ...(query.to && { lt: new Date(query.to) }),
          },
        }),
        // Keyset: rows after (createdAt, id). The redundant `lte` becomes an index condition,
        // so the scan starts at the cursor; the OR alone is only a filter and every newer row
        // would be read and discarded (Part 21: 295 ms → 2 ms at 200k rows deep).
        ...(cursor && {
          AND: [{ createdAt: { lte: cursor.createdAt } }],
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }),
      },
      select: RUN_SUMMARY_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(summary),
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async get(workspaceId: string, runId: string) {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId, workspaceId },
      select: {
        ...RUN_SUMMARY_SELECT,
        workflowVersionId: true,
        triggerInput: true,
        correlationId: true,
        webhookDeliveryId: true,
        cancelRequestedAt: true,
        payloadsTrimmedAt: true,
        queuedAt: true,
        retries: { select: { id: true }, orderBy: { createdAt: 'asc' } },
        steps: {
          where: { status: StepStatus.FAILED },
          select: { nodeKey: true, nodeType: true, errorCategory: true, errorMessage: true },
          orderBy: { sequence: 'asc' },
          take: 1,
        },
      },
    });
    if (!run) throw new NotFoundException('Run not found');
    const failed = run.steps[0];
    return {
      ...summary(run),
      workflowVersionId: run.workflowVersionId,
      triggerInput: redactSecrets(run.triggerInput),
      correlationId: run.correlationId,
      webhookDeliveryId: run.webhookDeliveryId,
      queuedAt: run.queuedAt,
      cancelRequestedAt: run.cancelRequestedAt,
      /** Set when retention removed the steps' stored input/output (Part 21). */
      payloadsTrimmedAt: run.payloadsTrimmedAt,
      retriedByRunIds: run.retries.map((r) => r.id),
      failedStep: failed
        ? {
            nodeKey: failed.nodeKey,
            nodeType: failed.nodeType,
            error: describeError(failed.errorCategory, failed.errorMessage),
          }
        : null,
    };
  }

  async steps(workspaceId: string, runId: string) {
    await this.findRun(workspaceId, runId);
    const steps = await this.prisma.stepRun.findMany({
      where: { runId },
      orderBy: { sequence: 'asc' },
      select: {
        id: true,
        nodeKey: true,
        nodeType: true,
        sequence: true,
        status: true,
        attemptCount: true,
        sanitizedInput: true,
        sanitizedOutput: true,
        errorCategory: true,
        errorMessage: true,
        externalRef: true,
        startedAt: true,
        completedAt: true,
        durationMs: true,
      },
    });
    return steps.map(({ sanitizedInput, sanitizedOutput, errorCategory, errorMessage, ...s }) => ({
      ...s,
      input: redactSecrets(sanitizedInput),
      output: redactSecrets(sanitizedOutput),
      error: describeError(errorCategory, errorMessage),
    }));
  }

  /**
   * QUEUED → CANCELLED immediately (and the job is removed); RUNNING → cancellation requested,
   * the engine stops before the next step. Terminal runs → 409.
   */
  async cancel(access: WorkspaceAccess, runId: string) {
    const run = await this.findRun(access.workspaceId, runId);
    if (TERMINAL.includes(run.status)) {
      throw new ConflictException({
        message: 'The run has already finished',
        details: { status: run.status },
      });
    }

    const cancelled = await this.prisma.workflowRun.updateMany({
      where: { id: runId, status: RunStatus.QUEUED },
      data: {
        status: RunStatus.CANCELLED,
        cancelRequestedAt: new Date(),
        completedAt: new Date(),
        lockedBy: null,
        lastErrorCategory: 'CANCELLED',
        errorMessage: 'Cancelled before it started',
      },
    });
    if (cancelled.count === 1) {
      await this.prisma.stepRun.updateMany({
        where: { runId, status: { in: [StepStatus.PENDING, StepStatus.RETRYING] } },
        data: { status: StepStatus.SKIPPED },
      });
      // Best effort: a job already picked up finds the run CANCELLED and does nothing.
      await this.queue.queue
        .remove(runId)
        .catch((err: Error) =>
          this.logger.warn({ runId, error: err.message }, 'Could not remove the queued job'),
        );
      await this.recordCancel(access, runId, 'run.cancelled');
      return { runId, status: RunStatus.CANCELLED, cancelRequested: true };
    }

    // Already RUNNING (or just claimed): ask the engine to stop before its next step.
    const requested = await this.prisma.workflowRun.updateMany({
      where: { id: runId, status: RunStatus.RUNNING },
      data: { cancelRequestedAt: new Date() },
    });
    const current = await this.findRun(access.workspaceId, runId);
    if (requested.count === 0 && TERMINAL.includes(current.status)) {
      throw new ConflictException({
        message: 'The run has already finished',
        details: { status: current.status },
      });
    }
    await this.recordCancel(access, runId, 'run.cancel_requested');
    return { runId, status: current.status, cancelRequested: true };
  }

  private recordCancel(access: WorkspaceAccess, runId: string, action: string) {
    return this.audit.record({
      action,
      workspaceId: access.workspaceId,
      actorUserId: access.userId,
      targetType: 'WorkflowRun',
      targetId: runId,
    });
  }

  private async findRun(workspaceId: string, runId: string) {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId, workspaceId },
      select: { id: true, status: true },
    });
    if (!run) throw new NotFoundException('Run not found');
    return run;
  }
}
