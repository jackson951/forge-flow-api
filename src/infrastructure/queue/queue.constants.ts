/**
 * Queue names and job payload contracts shared by the API (producer) and the worker
 * (consumer). Payloads carry ids only — never workflow data, inputs or secrets; the worker
 * re-loads everything from the database.
 */
export const QUEUES = {
  WORKFLOW_RUNS: 'workflow-runs',
  MAINTENANCE: 'maintenance',
} as const;

export const JOBS = {
  EXECUTE_RUN: 'execute-run',
  SWEEP_QUEUED_RUNS: 'sweep-queued-runs',
} as const;

export interface ExecuteRunJobData {
  runId: string;
}
