import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { hostname } from 'node:os';
import { classifyError, OwnershipLostError } from '../engine/errors';
import { ExecutionEngine } from '../engine/execution/execution-engine';
import { PrismaRunStore } from './prisma-run-store';

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
      this.logger.info(
        { runId, jobId: job.jobId, attempt },
        'Run not claimable (finished or cancelled); skipping',
      );
      return;
    }

    const fields = {
      runId,
      jobId: job.jobId,
      attempt,
      workspaceId: claimed.workspaceId,
      workflowVersionId: claimed.workflowVersionId,
      correlationId: claimed.correlationId,
    };
    const isFinalAttempt = attempt >= job.maxAttempts;
    const started = Date.now();
    this.logger.info(fields, 'Run started');

    const { claim } = claimed;
    try {
      const outcome = await this.engine.execute(runId, { isFinalAttempt, claim });
      await this.store.finishRun(runId, outcome.status, claim);
      this.logger.info(
        { ...fields, status: outcome.status, durationMs: Date.now() - started },
        'Run finished',
      );
    } catch (err) {
      if (err instanceof OwnershipLostError) return this.ownershipLost(fields);
      const error = classifyError(err);
      const final = !error.retryable || isFinalAttempt;
      const logFields = {
        ...fields,
        errorCategory: error.category,
        durationMs: Date.now() - started,
      };

      try {
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
   * Another worker claimed the run after this one (this job was treated as stalled and
   * redelivered). The newer claim owns the run; this worker writes nothing more. Returning
   * (not throwing) keeps BullMQ from retrying on our behalf — the job is the other worker's.
   */
  private ownershipLost(fields: Record<string, unknown>): void {
    this.logger.warn(fields, 'Run was claimed by another worker; stopping without changes');
  }
}
