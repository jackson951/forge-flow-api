-- Verifies a load run (Part 21). psql -v ws=<workspace id> -f scripts/load/check-runs.sql
\set ON_ERROR_STOP on
\pset pager off

\echo '== runs by status'
SELECT status, count(*) FROM "WorkflowRun" WHERE "workspaceId" = :'ws' GROUP BY 1 ORDER BY 1;

\echo '== duplicate execution check: runs claimed more than once, steps started more than once'
SELECT
  (SELECT count(*) FROM "WorkflowRun" WHERE "workspaceId" = :'ws' AND "attemptCount" <> 1) AS runs_with_attempts_ne_1,
  (SELECT count(*) FROM "StepRun" s JOIN "WorkflowRun" r ON r.id = s."runId"
     WHERE r."workspaceId" = :'ws' AND s."attemptCount" > 1) AS steps_started_more_than_once,
  (SELECT count(*) FROM "StepRun" s JOIN "WorkflowRun" r ON r.id = s."runId"
     WHERE r."workspaceId" = :'ws') AS steps_total;

\echo '== timing (ms): queue wait = startedAt - queuedAt, run = completedAt - startedAt, drain = first queued to last completed'
SELECT count(*) AS runs,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM "startedAt" - "queuedAt") * 1000)) AS wait_p50,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM "startedAt" - "queuedAt") * 1000)) AS wait_p95,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM "completedAt" - "startedAt") * 1000)) AS run_p50,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM "completedAt" - "startedAt") * 1000)) AS run_p95,
  round(extract(epoch FROM max("completedAt") - min("queuedAt")) * 1000) AS drain_ms
FROM "WorkflowRun" WHERE "workspaceId" = :'ws' AND status = 'SUCCEEDED';
