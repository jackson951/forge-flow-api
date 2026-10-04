/**
 * Queue names and job payload contracts shared by the API (producer) and the worker
 * (consumer). Payloads carry ids only — never workflow data, inputs or secrets; the worker
 * re-loads everything from the database.
 */
export const QUEUES = {
  WORKFLOW_RUNS: 'workflow-runs',
  MAINTENANCE: 'maintenance',
  /** http.poll occurrences (Part 24): one job per poll, separate so slow APIs never block maintenance. */
  HTTP_POLLS: 'http-polls',
} as const;

export const JOBS = {
  EXECUTE_RUN: 'execute-run',
  SWEEP_QUEUED_RUNS: 'sweep-queued-runs',
  APPLY_RETENTION: 'apply-retention',
  EVALUATE_SCHEDULES: 'evaluate-schedules',
  EXECUTE_POLL: 'execute-poll',
} as const;

export interface ExecuteRunJobData {
  runId: string;
}

export interface ExecutePollJobData {
  scheduleId: string;
  /** The occurrence (ISO-8601 UTC) this poll stands for. */
  occurrence: string;
}
