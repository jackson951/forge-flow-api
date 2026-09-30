export const QUEUES = {
  WORKFLOW_RUNS: 'workflow-runs',
} as const;

export const JOBS = {
  EXECUTE_RUN: 'execute-run',
} as const;

export interface ExecuteRunJobData {
  runId: string;
  workspaceId: string;
}
