import { ErrorCategory, RunStatus, StepStatus } from '@prisma/client';

/**
 * Persistence port of the execution engine. The engine depends only on this interface, so
 * it is unit-tested with an in-memory implementation; production uses PrismaRunStore.
 * Every state change is a conditional update that refuses illegal transitions.
 */

export interface RunSnapshot {
  id: string;
  workspaceId: string;
  status: RunStatus;
  triggerInput: unknown;
  cancelRequested: boolean;
  /** The immutable published definition (raw JSON, parsed by the engine). */
  definition: unknown;
}

export interface StepSnapshot {
  nodeKey: string;
  status: StepStatus;
  attemptCount: number;
  /** Stored (sanitised) output of a SUCCEEDED step, reused on resume. */
  output: unknown;
}

export interface PlannedStep {
  nodeKey: string;
  nodeType: string;
  sequence: number;
}

export interface StepFailure {
  status: 'FAILED' | 'RETRYING';
  category: ErrorCategory;
  message: string;
  durationMs?: number;
}

export interface RunStore {
  loadRun(runId: string): Promise<RunSnapshot | null>;
  isCancelRequested(runId: string): Promise<boolean>;

  /** Creates PENDING rows for every node; existing rows (resume) are left untouched. */
  planSteps(runId: string, steps: PlannedStep[]): Promise<void>;
  loadSteps(runId: string): Promise<Map<string, StepSnapshot>>;

  /** → RUNNING, attemptCount + 1, records the sanitised input. Returns the new attempt. */
  startStep(runId: string, nodeKey: string, sanitizedInput: unknown): Promise<number>;
  completeStep(
    runId: string,
    nodeKey: string,
    result: { sanitizedOutput: unknown; durationMs: number; externalRef?: string },
  ): Promise<void>;
  failStep(runId: string, nodeKey: string, failure: StepFailure): Promise<void>;
  /** Marks every still PENDING/RETRYING step SKIPPED. */
  skipRemaining(runId: string): Promise<void>;
}
