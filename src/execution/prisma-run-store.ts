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
  workflowId: string;
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
   * Claims the run for this worker. QUEUED → RUNNING normally; RUNNING → RUNNING when a
   * stalled job is redelivered (its worker is presumed dead). Each claim stores a unique
   * fencing token in `lockedBy`: the newest claim owns the run, and every fenced write by an
   * older claim fails with OwnershipLostError (Part 15). Returns null when the run is
   * terminal or cancelled, so the job just ends.
   *
   * One statement (one commit) rather than update + update + select: commits are the
   * bottleneck under load (Part 21, every commit waits for a WAL flush).
   */
  async claimRun(runId: string, workerId: string): Promise<ClaimedRun | null> {
    const claim = `${workerId}:${randomUUID()}`;
    const from = runStatusesLeadingTo('RUNNING');
    const rows = await this.prisma.$queryRaw<Omit<ClaimedRun, 'claim'>[]>`
      UPDATE "WorkflowRun"
      SET status = 'RUNNING',
          "attemptCount" = "attemptCount" + 1,
          "lockedBy" = ${claim},
          "startedAt" = COALESCE("startedAt", now()),
          "updatedAt" = now()
      WHERE id = ${runId}::uuid
        AND status = ANY(${from}::"RunStatus"[])
        AND "cancelRequestedAt" IS NULL
      RETURNING id, "workspaceId", "workflowId", "workflowVersionId", "correlationId",
                "attemptCount"`;
    return rows.length ? { ...rows[0], claim } : null;
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

  /**
   * RUNNING → QUEUED without an error: the run was postponed before its next step started
   * (no provider slot, Part 21). The claim's attempt is given back, since nothing was tried.
   */
  async releaseRun(runId: string, claim: string): Promise<void> {
    await this.transitionRun(runId, claim, RunStatus.QUEUED, {
      lockedBy: null,
      attemptCount: { decrement: 1 },
    });
  }

  /**
   * A QUEUED run with a cancellation request is never claimed; finish it as CANCELLED.
   * Returns whether this call cancelled it.
   */
  async cancelIfRequested(runId: string): Promise<boolean> {
    const result = await this.prisma.workflowRun.updateMany({
      where: { id: runId, status: RunStatus.QUEUED, cancelRequestedAt: { not: null } },
      data: {
        status: RunStatus.CANCELLED,
        completedAt: new Date(),
        lockedBy: null,
        lastErrorCategory: 'CANCELLED',
        errorMessage: 'Cancelled',
      },
    });
    if (result.count === 1) {
      await this.prisma.stepRun.updateMany({
        where: { runId, status: { in: stepStatusesLeadingTo('SKIPPED') } },
        data: { status: StepStatus.SKIPPED },
      });
    }
    return result.count === 1;
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
