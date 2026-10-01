import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RunStatus, TriggerSource, WorkflowStatus } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { parseDefinition } from '../../engine/definition/definition.schema';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RunQueue } from '../../infrastructure/queue/run-queue.service';

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

    try {
      await this.queue.enqueue(run.id);
    } catch (err) {
      this.logger.warn(
        { runId: run.id, error: (err as Error).message },
        'Enqueue failed; the sweeper will pick the run up',
      );
    }
    this.logger.info({ runId: run.id, workflowId, workflowVersionId: version.id }, 'Run queued');
    return { runId: run.id, status: run.status };
  }
}
