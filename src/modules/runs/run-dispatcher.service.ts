import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ErrorCategory,
  Prisma,
  RunStatus,
  StepStatus,
  TriggerSource,
  WorkflowStatus,
} from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { parseDefinition } from '../../engine/definition/definition.schema';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RunQueue } from '../../infrastructure/queue/run-queue.service';
import { AuditService } from '../audit/audit.service';

export interface ManualRunRequest {
  workspaceId: string;
  workflowId: string;
  input: Record<string, unknown>;
  /** Client-supplied Idempotency-Key header: retries of the same request create one run. */
  idempotencyKey?: string;
  correlationId?: string;
}

export interface DispatchedRun {
  runId: string;
  status: RunStatus;
}

export interface RetryRequest {
  workspaceId: string;
  userId: string;
  runId: string;
  resumeFromFailedStep?: boolean;
  acknowledgeUncertainOutcome?: boolean;
  /** Idempotency-Key header: repeated retry requests with the same key create one run. */
  idempotencyKey?: string;
  correlationId?: string;
}

export interface RetriedRun extends DispatchedRun {
  retryOfRunId: string;
  /** Steps whose stored outputs were reused instead of executed again. */
  reusedSteps: string[];
}

/**
 * API side of execution: records a QUEUED run bound to the workflow's active immutable
 * version, then enqueues it. Never executes anything itself.
 *
 * DB first, then Redis. If the enqueue fails after the commit, the run stays QUEUED and the
 * worker's sweeper re-enqueues it, so the request can still succeed.
 */
@Injectable()
export class RunDispatcherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: RunQueue,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RunDispatcherService.name);
  }

  async createManualRun(request: ManualRunRequest): Promise<DispatchedRun> {
    const { workspaceId, workflowId } = request;
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, workspaceId },
      select: {
        status: true,
        activeVersion: { select: { id: true, definition: true } },
      },
    });
    if (!workflow) throw new NotFoundException('Workflow not found');
    if (workflow.status === WorkflowStatus.ARCHIVED) {
      throw new ConflictException('Archived workflows cannot be run');
    }
    const version = workflow.activeVersion;
    if (!version) throw new ConflictException('Publish the workflow before running it');

    const parsed = parseDefinition(version.definition);
    const trigger = parsed.ok
      ? parsed.definition.nodes.find((n) => n.kind === 'TRIGGER')
      : undefined;
    if (trigger?.type !== 'manual.trigger') {
      throw new ConflictException('This workflow is started by its trigger, not manually');
    }

    const idempotencyKey = `manual:${request.idempotencyKey ?? randomUUID()}`;
    let run: { id: string; status: RunStatus; workflowId: string };
    try {
      run = await this.prisma.workflowRun.create({
        data: {
          workspaceId,
          workflowId,
          workflowVersionId: version.id,
          triggerSource: TriggerSource.MANUAL,
          idempotencyKey,
          triggerInput: request.input as Prisma.InputJsonObject,
          correlationId: request.correlationId,
        },
        select: { id: true, status: true, workflowId: true },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      // Same Idempotency-Key again: return the run it already created.
      const existing = await this.prisma.workflowRun.findUniqueOrThrow({
        where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
        select: { id: true, status: true, workflowId: true },
      });
      if (existing.workflowId !== workflowId) {
        throw new ConflictException('This Idempotency-Key was already used for another workflow');
      }
      return { runId: existing.id, status: existing.status };
    }

    await this.enqueue(run.id, { workspaceId, workflowId, correlationId: request.correlationId });
    this.logger.info({ runId: run.id, workflowId, workflowVersionId: version.id }, 'Run queued');
    return { runId: run.id, status: run.status };
  }

  /**
   * Manual retry of a FAILED run (Part 15, S6): a new run on the **same immutable version**
   * with the same stored trigger input and new idempotency keys. Input and version cannot be
   * changed. If the failed step ended with UNCERTAIN_OUTCOME the action may already have
   * happened, so the caller must acknowledge that explicitly — this is the only path by which
   * FlowForge may repeat a side effect, and only on a human decision.
   *
   * With `resumeFromFailedStep`, SUCCEEDED steps are copied into the new run with their
   * stored (sanitised) outputs, so the engine does not execute them again.
   */
  async retryRun(request: RetryRequest): Promise<RetriedRun> {
    const { workspaceId, runId } = request;
    const original = await this.prisma.workflowRun.findFirst({
      where: { id: runId, workspaceId },
      select: {
        id: true,
        status: true,
        workflowId: true,
        workflowVersionId: true,
        triggerInput: true,
        workflow: { select: { status: true } },
        steps: {
          select: {
            nodeKey: true,
            nodeType: true,
            sequence: true,
            status: true,
            errorCategory: true,
            sanitizedInput: true,
            sanitizedOutput: true,
            externalRef: true,
          },
        },
      },
    });
    if (!original) throw new NotFoundException('Run not found');
    if (original.status !== RunStatus.FAILED) {
      throw new ConflictException({
        message: 'Only failed runs can be retried',
        details: { status: original.status },
      });
    }
    if (original.workflow.status === WorkflowStatus.ARCHIVED) {
      throw new ConflictException('Archived workflows cannot be run');
    }
    const uncertain = original.steps
      .filter(
        (s) =>
          s.status === StepStatus.FAILED && s.errorCategory === ErrorCategory.UNCERTAIN_OUTCOME,
      )
      .map((s) => s.nodeKey);
    if (uncertain.length && !request.acknowledgeUncertainOutcome) {
      throw new ConflictException({
        message:
          'The failed step may already have completed (outcome unknown). Check the provider first; to retry anyway, send acknowledgeUncertainOutcome: true',
        details: { code: 'UNCERTAIN_OUTCOME', nodeKeys: uncertain },
      });
    }

    const reused = request.resumeFromFailedStep
      ? original.steps.filter((s) => s.status === StepStatus.SUCCEEDED)
      : [];
    const idempotencyKey = `retry:${original.id}:${request.idempotencyKey ?? randomUUID()}`;

    let created: { id: string; status: RunStatus };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const run = await tx.workflowRun.create({
          data: {
            workspaceId,
            workflowId: original.workflowId,
            workflowVersionId: original.workflowVersionId,
            triggerSource: TriggerSource.RETRY,
            retryOfRunId: original.id,
            idempotencyKey,
            triggerInput: (original.triggerInput ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            correlationId: request.correlationId,
          },
          select: { id: true, status: true },
        });
        if (reused.length) {
          await tx.stepRun.createMany({
            data: reused.map((s) => ({
              runId: run.id,
              nodeKey: s.nodeKey,
              nodeType: s.nodeType,
              sequence: s.sequence,
              status: StepStatus.SUCCEEDED,
              sanitizedInput: s.sanitizedInput ?? Prisma.JsonNull,
              sanitizedOutput: s.sanitizedOutput ?? Prisma.JsonNull,
              externalRef: s.externalRef,
              completedAt: new Date(),
            })),
          });
        }
        await this.audit.record(
          {
            action: 'run.retried',
            workspaceId,
            actorUserId: request.userId,
            targetType: 'WorkflowRun',
            targetId: run.id,
            metadata: {
              retryOfRunId: original.id,
              resumeFromFailedStep: Boolean(request.resumeFromFailedStep),
              reusedSteps: reused.map((s) => s.nodeKey),
              acknowledgedUncertainSteps: uncertain,
            },
          },
          tx,
        );
        return run;
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      // Same Idempotency-Key again: return the retry it already created.
      const existing = await this.prisma.workflowRun.findUniqueOrThrow({
        where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
        select: {
          id: true,
          status: true,
        },
      });
      return {
        runId: existing.id,
        status: existing.status,
        retryOfRunId: original.id,
        reusedSteps: [],
      };
    }

    await this.enqueue(created.id, {
      workspaceId,
      workflowId: original.workflowId,
      correlationId: request.correlationId,
    });
    this.logger.info(
      { runId: created.id, retryOfRunId: original.id, reusedSteps: reused.length },
      'Run retry queued',
    );
    return {
      runId: created.id,
      status: created.status,
      retryOfRunId: original.id,
      reusedSteps: reused.map((s) => s.nodeKey),
    };
  }

  /** DB first, then Redis: a failed enqueue leaves the run QUEUED for the sweeper. */
  private async enqueue(runId: string, context: Record<string, unknown>): Promise<void> {
    try {
      await this.queue.enqueue(runId, context);
    } catch (err) {
      this.logger.warn(
        { runId, error: (err as Error).message },
        'Enqueue failed; the sweeper will pick the run up',
      );
    }
  }
}
