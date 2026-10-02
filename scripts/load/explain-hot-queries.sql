-- EXPLAIN ANALYZE of the hot queries (Part 21, FR-21.5 / AC-21.2) on the seeded perf
-- database. Statements mirror what Prisma generates for the services named in each title.
--   psql -f scripts/load/explain-hot-queries.sql
\set ON_ERROR_STOP on
\pset pager off

SELECT id AS ws FROM "Workspace" WHERE name = 'perf-1' \gset
SELECT "userId" AS uid FROM "WorkspaceMember" WHERE "workspaceId" = :'ws' LIMIT 1 \gset
SELECT id AS run, "workflowId" AS wf FROM "WorkflowRun" WHERE "workspaceId" = :'ws'
  ORDER BY "createdAt" DESC, id DESC LIMIT 1 OFFSET 5000 \gset
-- Cursor 10 000 rows deep into the hot workspace's history.
SELECT "createdAt" AS cur_at, id AS cur_id FROM "WorkflowRun" WHERE "workspaceId" = :'ws'
  ORDER BY "createdAt" DESC, id DESC LIMIT 1 OFFSET 10000 \gset
SELECT count(*) AS ws_runs FROM "WorkflowRun" WHERE "workspaceId" = :'ws' \gset
\echo hot workspace runs: :ws_runs

\echo '== Q1 run list, first page (RunsService.list)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, "workflowId", "workflowVersionId", status, "triggerSource", "attemptCount",
       "lastErrorCategory", "errorMessage", "retryOfRunId", "createdAt", "startedAt", "completedAt"
FROM "WorkflowRun" WHERE "workspaceId" = :'ws'
ORDER BY "createdAt" DESC, id DESC LIMIT 21 OFFSET 0;

\echo '== Q2 run list, keyset page 10 000 rows deep (RunsService.list with cursor)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, "workflowId", status, "createdAt" FROM "WorkflowRun"
WHERE "workspaceId" = :'ws'
  AND ("createdAt" < :'cur_at' OR ("createdAt" = :'cur_at' AND id < :'cur_id'))
ORDER BY "createdAt" DESC, id DESC LIMIT 21 OFFSET 0;

\echo '== Q2b for comparison: the same page by OFFSET (not used by the API)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, "workflowId", status, "createdAt" FROM "WorkflowRun"
WHERE "workspaceId" = :'ws' ORDER BY "createdAt" DESC, id DESC LIMIT 21 OFFSET 10000;

\echo '== Q3 run list filtered by status (RunsService.list ?status=FAILED)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, status, "createdAt" FROM "WorkflowRun"
WHERE "workspaceId" = :'ws' AND status = 'FAILED'
ORDER BY "createdAt" DESC, id DESC LIMIT 21 OFFSET 0;

\echo '== Q4 run list filtered by workflow (RunsService.list ?workflowId=)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, status, "createdAt" FROM "WorkflowRun"
WHERE "workspaceId" = :'ws' AND "workflowId" = :'wf'
ORDER BY "createdAt" DESC, id DESC LIMIT 21 OFFSET 0;

\echo '== Q4b run list relations, loaded once per page (Prisma batches them)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, name FROM "Workflow" WHERE id IN (
  SELECT "workflowId" FROM "WorkflowRun" WHERE "workspaceId" = :'ws'
  ORDER BY "createdAt" DESC, id DESC LIMIT 21);

\echo '== Q5 step list (RunsService.steps)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT * FROM "StepRun" WHERE "runId" = :'run' ORDER BY sequence ASC OFFSET 0;

\echo '== Q6 membership check (WorkspaceAccessGuard)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, role FROM "WorkspaceMember"
WHERE "workspaceId" = :'ws' AND "userId" = :'uid' LIMIT 1 OFFSET 0;

\echo '== Q7 webhook trigger match (WebhookIntakeService.record)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT t.id, t."workspaceId", t."workflowId", t."workflowVersionId"
FROM "WorkflowTrigger" t JOIN "Workflow" w ON w.id = t."workflowId"
WHERE t.provider = 'GITHUB' AND t."eventType" = 'issues.opened'
  AND t."resourceKey" = '100050:perf/repo-7' AND w.status = 'PUBLISHED';

\echo '== Q8 dashboard: runs by status, last 7 days (DashboardService)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT status, count(*) FROM "WorkflowRun"
WHERE "workspaceId" = :'ws' AND "createdAt" >= now() - interval '7 days'
GROUP BY status;

\echo '== Q9 dashboard: recent failures (DashboardService)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, "workflowId", "lastErrorCategory", "createdAt" FROM "WorkflowRun"
WHERE "workspaceId" = :'ws' AND status = 'FAILED'
ORDER BY "createdAt" DESC, id DESC LIMIT 10 OFFSET 0;

\echo '== Q10 sweeper: stale QUEUED runs (PrismaRunStore.findStaleQueuedRuns)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id FROM "WorkflowRun"
WHERE status = 'QUEUED' AND "queuedAt" < now() - interval '1 minute'
ORDER BY "queuedAt" ASC LIMIT 100 OFFSET 0;

\echo '== Q11 retention: next batch of runs to delete (RetentionService)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id FROM "WorkflowRun"
WHERE "createdAt" < now() - interval '90 days' AND status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
ORDER BY "createdAt" LIMIT 1000 FOR UPDATE SKIP LOCKED;

\echo '== Q12 retention: next batch of runs to trim (RetentionService)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id FROM "WorkflowRun"
WHERE "payloadsTrimmedAt" IS NULL AND "createdAt" < now() - interval '30 days'
  AND status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
ORDER BY "createdAt" LIMIT 1000 FOR UPDATE SKIP LOCKED;

\echo '== Q13 retention: next batch of deliveries (RetentionService)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id FROM "WebhookDelivery" WHERE "receivedAt" < now() - interval '30 days'
ORDER BY "receivedAt" LIMIT 1000 FOR UPDATE SKIP LOCKED;

\echo '== Q14 deleting 50 and 1 000 runs WITH the retryOfRunId index (rolled back)'
BEGIN;
EXPLAIN (ANALYZE, COSTS OFF)
DELETE FROM "WorkflowRun" WHERE id IN (
  SELECT id FROM "WorkflowRun" WHERE "createdAt" < now() - interval '90 days'
    AND status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
  ORDER BY "createdAt" LIMIT 50);
ROLLBACK;
BEGIN;
EXPLAIN (ANALYZE, COSTS OFF)
DELETE FROM "WorkflowRun" WHERE id IN (
  SELECT id FROM "WorkflowRun" WHERE "createdAt" < now() - interval '90 days'
    AND status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
  ORDER BY "createdAt" LIMIT 1000);
ROLLBACK;

\echo '== Q15 deleting 50 runs WITHOUT the retryOfRunId index (dropped inside the rolled-back transaction); 1 000 would take ~20x longer'
BEGIN;
DROP INDEX "WorkflowRun_retryOfRunId_idx";
EXPLAIN (ANALYZE, COSTS OFF)
DELETE FROM "WorkflowRun" WHERE id IN (
  SELECT id FROM "WorkflowRun" WHERE "createdAt" < now() - interval '90 days'
    AND status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
  ORDER BY "createdAt" LIMIT 50);
ROLLBACK;
