import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { hostname } from 'node:os';
import { classifyError, OwnershipLostError } from '../engine/errors';
import { ExecutionEngine } from '../engine/execution/execution-engine';
import { ProviderSlotsBusyError } from '../engine/execution/provider-slots';
import { PrismaRunStore } from './prisma-run-store';

/**
 * Thrown to the processor when a run was postponed (no provider slot free): the job is moved
 * back to delayed without counting as an attempt.
 */
export class RunPostponedError extends Error {
  constructor(readonly delayMs: number) {
    super('Run postponed');
    this.name = 'RunPostponedError';
  }
}

export interface JobAttempt {
  jobId: string;
  /** Attempts already made before this one (BullMQ `attemptsMade`). */
  attemptsMade: number;
  maxAttempts: number;
}

/**
 * Run-level lifecycle around the engine: claim the run, execute, then record the outcome.
 *
 * Errors are re-thrown for BullMQ: retryable errors with attempts left → the job is retried
 * with backoff (the run goes back to QUEUED and the engine resumes at the failed step);
 * permanent errors → UnrecoverableError, so BullMQ does not retry; retries exhausted → run
 * FAILED and the job fails.
 */
@Injectable()
export class RunWorkerService {
  private readonly workerId = `${hostname()}:${process.pid}`;

  constructor(
    private readonly store: PrismaRunStore,
    private readonly engine: ExecutionEngine,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RunWorkerService.name);
  }

  async process(runId: string, job: JobAttempt): Promise<void> {
    const attempt = job.attemptsMade + 1;
    const claimed = await this.store.claimRun(runId, this.workerId);
    if (!claimed) {
      const cancelled = await this.store.cancelIfRequested(runId);
      this.logger.info(
        { runId, jobId: job.jobId, attempt },
        cancelled
          ? 'Run cancelled before it started'
          : 'Run not claimable (finished or cancelled); skipping',
      );
      return;
    }

    const fields = {
      runId,
      jobId: job.jobId,
      attempt,
      workspaceId: claimed.workspaceId,
      workflowId: claimed.workflowId,
      workflowVersionId: claimed.workflowVersionId,
      correlationId: claimed.correlationId,
    };
    const isFinalAttempt = attempt >= job.maxAttempts;
    const started = Date.now();
    this.logger.info(fields, 'Run started');

    const { claim } = claimed;
    try {
      const outcome = await this.engine.execute(runId, {
        isFinalAttempt,
        claim,
        logFields: fields,
      });
      await this.store.finishRun(runId, outcome.status, claim);
      this.logger.info(
        { ...fields, status: outcome.status, durationMs: Date.now() - started },
        'Run finished',
      );
    } catch (err) {
      if (err instanceof OwnershipLostError) return this.ownershipLost(fields);
      if (err instanceof ProviderSlotsBusyError) return this.postpone(runId, claim, err, fields);
      const error = classifyError(err);
      const final = !error.retryable || isFinalAttempt;
      const logFields = {
        ...fields,
        errorCategory: error.category,
        durationMs: Date.now() - started,
      };

      try {
        // A retry would put the run back in QUEUED, where a cancelled run is never claimed.
        if (!final && (await this.store.isCancelRequested(runId))) {
          await this.store.skipRemaining(runId, claim);
          await this.store.finishRun(runId, 'CANCELLED', claim);
          this.logger.info(logFields, 'Run cancelled instead of retried');
          return;
        }
        if (final) await this.store.failRun(runId, error, claim);
        else await this.store.requeueRun(runId, error, claim);
      } catch (persistErr) {
        if (persistErr instanceof OwnershipLostError) return this.ownershipLost(fields);
        // Database unavailable: let BullMQ retry; the run is re-claimed from RUNNING.
        this.logger.warn(
          { ...logFields, persistError: (persistErr as Error).message },
          'Could not record run outcome',
        );
        throw err;
      }

      if (final) {
        this.logger.warn({ ...logFields, retryable: error.retryable }, 'Run failed');
        if (!error.retryable) throw new UnrecoverableError(error.message);
      } else {
        this.logger.warn(logFields, 'Run attempt failed; retry scheduled');
      }
      throw err;
    }
  }

  /**
   * No slot for the next step's provider: give the run back (QUEUED, attempt not counted) and
   * let the processor delay the job. Steps already done stay done; the next claim resumes.
   */
  private async postpone(
    runId: string,
    claim: string,
    err: ProviderSlotsBusyError,
    fields: Record<string, unknown>,
  ): Promise<void> {
    try {
      if (await this.store.isCancelRequested(runId)) {
        await this.store.skipRemaining(runId, claim);
        await this.store.finishRun(runId, 'CANCELLED', claim);
        this.logger.info(fields, 'Run cancelled instead of postponed');
        return;
      }
      await this.store.releaseRun(runId, claim);
    } catch (persistErr) {
      if (persistErr instanceof OwnershipLostError) return this.ownershipLost(fields);
      throw persistErr;
    }
    this.logger.debug(
      { ...fields, provider: err.provider, delayMs: err.retryAfterMs },
      'Provider busy; run postponed',
    );
    throw new RunPostponedError(err.retryAfterMs);
  }

  /**
   * Another worker claimed the run after this one (this job was treated as stalled and
   * redelivered). The newer claim owns the run; this worker writes nothing more. Returning
   * (not throwing) keeps BullMQ from retrying on our behalf — the job is the other worker's.
   */
  private ownershipLost(fields: Record<string, unknown>): void {
    this.logger.warn(fields, 'Run was claimed by another worker; stopping without changes');
  }
}
