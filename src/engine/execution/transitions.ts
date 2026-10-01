import { RunStatus, StepStatus } from '@prisma/client';

/**
 * Explicit state machines (docs/backend/08-WORKFLOW-EXECUTION-ENGINE.md).
 *
 *   WorkflowRun: QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELLED
 *                RUNNING → QUEUED (retry scheduled),  QUEUED → CANCELLED | FAILED
 *                RUNNING → RUNNING (stalled job redelivered to another worker)
 *   StepRun:     PENDING → RUNNING → SUCCEEDED | FAILED | RETRYING,  RETRYING → RUNNING
 *                RUNNING → RUNNING (re-executing an idempotent step after a crash)
 *                PENDING | RETRYING → SKIPPED
 *                PENDING → FAILED (fails before starting: no handler, unresolvable config)
 */
const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  QUEUED: ['RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['RUNNING', 'QUEUED', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

const STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  PENDING: ['RUNNING', 'SKIPPED', 'FAILED'],
  RUNNING: ['RUNNING', 'SUCCEEDED', 'FAILED', 'RETRYING'],
  RETRYING: ['RUNNING', 'SKIPPED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [],
  SKIPPED: [],
};

export class IllegalTransitionError extends Error {
  constructor(kind: 'run' | 'step', from: string, to: string) {
    super(`Illegal ${kind} transition ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export const canTransitionRun = (from: RunStatus, to: RunStatus) =>
  RUN_TRANSITIONS[from].includes(to);

export const canTransitionStep = (from: StepStatus, to: StepStatus) =>
  STEP_TRANSITIONS[from].includes(to);

/** States from which `to` is reachable; used to build conditional (race-safe) updates. */
export const runStatusesLeadingTo = (to: RunStatus): RunStatus[] =>
  (Object.keys(RUN_TRANSITIONS) as RunStatus[]).filter((from) => canTransitionRun(from, to));

export const stepStatusesLeadingTo = (to: StepStatus): StepStatus[] =>
  (Object.keys(STEP_TRANSITIONS) as StepStatus[]).filter((from) => canTransitionStep(from, to));

export const isTerminalRun = (status: RunStatus) => RUN_TRANSITIONS[status].length === 0;
