import { Injectable } from '@nestjs/common';
import { Prisma, RunStatus, StepStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ClassifiedError, OwnershipLostError } from '../engine/errors';
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
  /** Fencing token stored in `lockedBy`; pass it to every fenced write. */
  claim: string;
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
  /**
   * Claims the run for this worker. QUEUED → RUNNING normally; RUNNING → RUNNING when a
   * stalled job is redelivered (its worker is presumed dead). Each claim stores a unique
   * fencing token in `lockedBy`: the newest claim owns the run, and every fenced write by an
   * older claim fails with OwnershipLostError (Part 15).
   */
  async claimRun(runId: string, workerId: string): Promise<ClaimedRun | null> {
    const claim = `${workerId}:${randomUUID()}`;
    const claimed = await this.prisma.workflowRun.updateMany({
      where: {
        id: runId,
        status: { in: runStatusesLeadingTo('RUNNING') },
        cancelRequestedAt: null,
      },
      data: { status: RunStatus.RUNNING, attemptCount: { increment: 1 }, lockedBy: claim },
    });
    if (claimed.count === 0) return null;
    await this.prisma.workflowRun.updateMany({
      where: { id: runId, startedAt: null },
      data: { startedAt: new Date() },
    });
    const run = await this.prisma.workflowRun.findUniqueOrThrow({
      where: { id: runId },
      select: {
        id: true,
        workspaceId: true,
        workflowVersionId: true,
        correlationId: true,
        attemptCount: true,
      },
    });
    return { ...run, claim };
  }

  async finishRun(runId: string, status: 'SUCCEEDED' | 'CANCELLED', claim: string): Promise<void> {
    await this.transitionRun(runId, claim, status, {
      completedAt: new Date(),
      lockedBy: null,
      ...(status === 'CANCELLED' && { lastErrorCategory: 'CANCELLED' }),
    });
  }

  async failRun(runId: string, error: ClassifiedError, claim: string): Promise<void> {
    await this.transitionRun(runId, claim, RunStatus.FAILED, {
      completedAt: new Date(),
      lockedBy: null,
      lastErrorCategory: error.category,
      errorMessage: error.message,
    });
  }

  /** RUNNING → QUEUED while BullMQ waits to retry the job. */
  async requeueRun(runId: string, error: ClassifiedError, claim: string): Promise<void> {
    await this.transitionRun(runId, claim, RunStatus.QUEUED, {
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

  async startStep(
    runId: string,
    nodeKey: string,
    sanitizedInput: unknown,
    claim?: string,
  ): Promise<number> {
    await this.transitionStep(runId, nodeKey, StepStatus.RUNNING, claim, {
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
    await this.transitionStep(runId, nodeKey, StepStatus.SUCCEEDED, undefined, {
      sanitizedOutput: json(result.sanitizedOutput),
      durationMs: result.durationMs,
      externalRef: result.externalRef,
      completedAt: new Date(),
    });
  }

  async failStep(
    runId: string,
    nodeKey: string,
    failure: StepFailure,
    claim?: string,
  ): Promise<void> {
    await this.transitionStep(runId, nodeKey, failure.status, claim, {
      errorCategory: failure.category,
      errorMessage: failure.message,
      durationMs: failure.durationMs,
      ...(failure.status === 'FAILED' && { completedAt: new Date() }),
    });
  }

  async skipRemaining(runId: string, claim?: string): Promise<void> {
    const updated = await this.prisma.stepRun.updateMany({
      where: {
        runId,
        status: { in: stepStatusesLeadingTo('SKIPPED') },
        ...(claim && { run: { lockedBy: claim } }),
      },
      data: { status: StepStatus.SKIPPED },
    });
    if (claim && updated.count === 0) await this.assertOwner(runId, claim);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Fenced run transition: only the current claim may decide the run's outcome. */
  private async transitionRun(
    runId: string,
    claim: string,
    to: RunStatus,
    data: Prisma.WorkflowRunUpdateManyMutationInput,
  ): Promise<void> {
    const updated = await this.prisma.workflowRun.updateMany({
      where: { id: runId, lockedBy: claim, status: { in: runStatusesLeadingTo(to) } },
      data: { ...data, status: to },
    });
    if (updated.count === 0) {
      const current = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
      if (current && current.lockedBy !== claim) throw new OwnershipLostError(runId);
      throw new IllegalTransitionError('run', current?.status ?? 'missing', to);
    }
  }

  private async assertOwner(runId: string, claim: string): Promise<void> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      select: { lockedBy: true },
    });
    if (run?.lockedBy !== claim) throw new OwnershipLostError(runId);
  }

  private async transitionStep(
    runId: string,
    nodeKey: string,
    to: StepStatus,
    claim: string | undefined,
    data: Prisma.StepRunUpdateManyMutationInput,
  ): Promise<void> {
    const updated = await this.prisma.stepRun.updateMany({
      where: {
        runId,
        nodeKey,
        status: { in: stepStatusesLeadingTo(to) },
        ...(claim && { run: { lockedBy: claim } }),
      },
      data: { ...data, status: to },
    });
    if (updated.count === 0) {
      if (claim) await this.assertOwner(runId, claim);
      const current = await this.prisma.stepRun.findUnique({
        where: { runId_nodeKey: { runId, nodeKey } },
      });
      throw new IllegalTransitionError('step', current?.status ?? 'missing', to);
    }
  }
}
