import { Injectable } from '@nestjs/common';
import { Prisma, RunStatus, StepStatus } from '@prisma/client';
import { ClassifiedError } from '../engine/errors';
import {
  PlannedStep,
  RunSnapshot,
  RunStore,
  StepFailure,
  StepSnapshot,
} from '../engine/execution/run-store';
import {
  IllegalTransitionError,
  runStatusesLeadingTo,
  stepStatusesLeadingTo,
} from '../engine/execution/transitions';
import { PrismaService } from '../infrastructure/prisma/prisma.service';

const json = (value: unknown) => value as Prisma.InputJsonValue;

export interface ClaimedRun {
  id: string;
  workspaceId: string;
  workflowVersionId: string;
  correlationId: string | null;
  attemptCount: number;
}

/**
 * Prisma implementation of the engine's RunStore, plus run-level lifecycle used by the
 * worker. Every transition is a conditional `updateMany` on the allowed source states, so a
 * concurrent or stale writer gets an IllegalTransitionError instead of overwriting state.
 */
@Injectable()
export class PrismaRunStore implements RunStore {
  constructor(private readonly prisma: PrismaService) {}

  // ── run lifecycle (worker) ─────────────────────────────────────────────────

  /**
   * QUEUED → RUNNING (or RUNNING → RUNNING when a stalled job is redelivered after its
   * worker died). Returns null when the run is terminal or cancelled, so the job just ends.
   */
  async claimRun(runId: string, workerId: string): Promise<ClaimedRun | null> {
    const claimed = await this.prisma.workflowRun.updateMany({
      where: {
        id: runId,
        status: { in: runStatusesLeadingTo('RUNNING') },
        cancelRequestedAt: null,
      },
      data: { status: RunStatus.RUNNING, attemptCount: { increment: 1 }, lockedBy: workerId },
    });
    if (claimed.count === 0) return null;
    await this.prisma.workflowRun.updateMany({
      where: { id: runId, startedAt: null },
      data: { startedAt: new Date() },
    });
    return this.prisma.workflowRun.findUniqueOrThrow({
      where: { id: runId },
      select: {
        id: true,
        workspaceId: true,
        workflowVersionId: true,
        correlationId: true,
        attemptCount: true,
      },
    });
  }

  async finishRun(runId: string, status: 'SUCCEEDED' | 'CANCELLED'): Promise<void> {
    await this.transitionRun(runId, status, {
      completedAt: new Date(),
      lockedBy: null,
      ...(status === 'CANCELLED' && { lastErrorCategory: 'CANCELLED' }),
    });
  }

  async failRun(runId: string, error: ClassifiedError): Promise<void> {
    await this.transitionRun(runId, RunStatus.FAILED, {
      completedAt: new Date(),
      lockedBy: null,
      lastErrorCategory: error.category,
      errorMessage: error.message,
    });
  }

  /** RUNNING → QUEUED while BullMQ waits to retry the job. */
  async requeueRun(runId: string, error: ClassifiedError): Promise<void> {
    await this.transitionRun(runId, RunStatus.QUEUED, {
      lockedBy: null,
      lastErrorCategory: error.category,
      errorMessage: error.message,
    });
  }

  /** QUEUED runs that may have missed their enqueue (DB committed, Redis call failed). */
  findStaleQueuedRuns(olderThan: Date, limit: number): Promise<{ id: string }[]> {
    return this.prisma.workflowRun.findMany({
      where: { status: RunStatus.QUEUED, queuedAt: { lt: olderThan }, cancelRequestedAt: null },
      select: { id: true },
      orderBy: { queuedAt: 'asc' },
      take: limit,
    });
  }

  // ── RunStore (engine) ──────────────────────────────────────────────────────

  async loadRun(runId: string): Promise<RunSnapshot | null> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        workspaceId: true,
        status: true,
        triggerInput: true,
        cancelRequestedAt: true,
        version: { select: { definition: true } },
      },
    });
    if (!run) return null;
    return {
      id: run.id,
      workspaceId: run.workspaceId,
      status: run.status,
      triggerInput: run.triggerInput,
      cancelRequested: run.cancelRequestedAt !== null,
      definition: run.version.definition,
    };
  }

  async isCancelRequested(runId: string): Promise<boolean> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      select: { cancelRequestedAt: true },
    });
    return run?.cancelRequestedAt != null;
  }

  async planSteps(runId: string, steps: PlannedStep[]): Promise<void> {
    await this.prisma.stepRun.createMany({
      data: steps.map((s) => ({ runId, ...s })),
      skipDuplicates: true,
    });
  }

  async loadSteps(runId: string): Promise<Map<string, StepSnapshot>> {
    const rows = await this.prisma.stepRun.findMany({
      where: { runId },
      select: { nodeKey: true, status: true, attemptCount: true, sanitizedOutput: true },
    });
    return new Map(
      rows.map((r) => [
        r.nodeKey,
        {
          nodeKey: r.nodeKey,
          status: r.status,
          attemptCount: r.attemptCount,
          output: r.sanitizedOutput,
        },
      ]),
    );
  }

  async startStep(runId: string, nodeKey: string, sanitizedInput: unknown): Promise<number> {
    await this.transitionStep(runId, nodeKey, StepStatus.RUNNING, {
      attemptCount: { increment: 1 },
      sanitizedInput: json(sanitizedInput),
      startedAt: new Date(),
      errorCategory: null,
      errorMessage: null,
    });
    const step = await this.prisma.stepRun.findUniqueOrThrow({
      where: { runId_nodeKey: { runId, nodeKey } },
      select: { attemptCount: true },
    });
    return step.attemptCount;
  }

  async completeStep(
    runId: string,
    nodeKey: string,
    result: { sanitizedOutput: unknown; durationMs: number; externalRef?: string },
  ): Promise<void> {
    await this.transitionStep(runId, nodeKey, StepStatus.SUCCEEDED, {
      sanitizedOutput: json(result.sanitizedOutput),
      durationMs: result.durationMs,
      externalRef: result.externalRef,
      completedAt: new Date(),
    });
  }

  async failStep(runId: string, nodeKey: string, failure: StepFailure): Promise<void> {
    await this.transitionStep(runId, nodeKey, failure.status, {
      errorCategory: failure.category,
      errorMessage: failure.message,
      durationMs: failure.durationMs,
      ...(failure.status === 'FAILED' && { completedAt: new Date() }),
    });
  }

  async skipRemaining(runId: string): Promise<void> {
    await this.prisma.stepRun.updateMany({
      where: { runId, status: { in: stepStatusesLeadingTo('SKIPPED') } },
      data: { status: StepStatus.SKIPPED },
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async transitionRun(
    runId: string,
    to: RunStatus,
    data: Prisma.WorkflowRunUpdateManyMutationInput,
  ): Promise<void> {
    const updated = await this.prisma.workflowRun.updateMany({
      where: { id: runId, status: { in: runStatusesLeadingTo(to) } },
      data: { ...data, status: to },
    });
    if (updated.count === 0) {
      const current = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
      throw new IllegalTransitionError('run', current?.status ?? 'missing', to);
    }
  }

  private async transitionStep(
    runId: string,
    nodeKey: string,
    to: StepStatus,
    data: Prisma.StepRunUpdateManyMutationInput,
  ): Promise<void> {
    const updated = await this.prisma.stepRun.updateMany({
      where: { runId, nodeKey, status: { in: stepStatusesLeadingTo(to) } },
      data: { ...data, status: to },
    });
    if (updated.count === 0) {
      const current = await this.prisma.stepRun.findUnique({
        where: { runId_nodeKey: { runId, nodeKey } },
      });
      throw new IllegalTransitionError('step', current?.status ?? 'missing', to);
    }
  }
}
