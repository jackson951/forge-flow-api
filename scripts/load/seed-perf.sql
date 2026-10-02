-- Perf database seed (Part 21). NEVER run against a real database: it inserts synthetic
-- tenants and ~3M rows. Use the throwaway stack described in scripts/load/README.md.
--
--   psql -v runs=1000000 -v workspaces=100 -f scripts/load/seed-perf.sql
--
-- Shape: `workspaces` workspaces with 10 members and 20 published workflows each; workspace
-- "perf-1" is the hot tenant with 40 % of all runs. Runs are spread over the last 120 days
-- (so retention has work), 2 steps each; deliveries = 30 % of runs. One workflow in perf-1 is
-- routed for TEST webhooks (event "load.event", resource "load-test") for the intake test.
\set ON_ERROR_STOP on
\if :{?runs} \else \set runs 1000000 \endif
\if :{?workspaces} \else \set workspaces 100 \endif

SET synchronous_commit = off;
\timing on
BEGIN;

CREATE TEMP TABLE ws ON COMMIT DROP AS
  SELECT n, gen_random_uuid() AS id FROM generate_series(1, :workspaces) n;
INSERT INTO "Workspace" (id, name, "createdAt", "updatedAt")
  SELECT id, 'perf-' || n, now(), now() FROM ws;

CREATE TEMP TABLE u ON COMMIT DROP AS
  SELECT n, gen_random_uuid() AS id FROM generate_series(1, :workspaces * 10) n;
INSERT INTO "User" (id, email, name, "passwordHash", "createdAt", "updatedAt")
  SELECT id, 'perf-' || n || '@perf.test', 'Perf ' || n, '!locked', now(), now() FROM u;
INSERT INTO "WorkspaceMember" (id, "workspaceId", "userId", role, "createdAt", "updatedAt")
  SELECT gen_random_uuid(), ws.id, u.id,
         (CASE WHEN u.n % 10 = 1 THEN 'OWNER' ELSE 'MEMBER' END)::"WorkspaceRole", now(), now()
  FROM u JOIN ws ON ws.n = (u.n - 1) / 10 + 1;

-- manual.trigger → util.log: executable by a real worker.
CREATE TEMP TABLE def ON COMMIT DROP AS SELECT
  '{"schemaVersion":1,"nodes":[{"key":"trigger","kind":"TRIGGER","type":"manual.trigger","config":{}},{"key":"log","kind":"ACTION","type":"util.log","config":{"message":"load test"}}],"edges":[{"from":"trigger","to":"log"}]}'::jsonb AS body;

CREATE TEMP TABLE wf ON COMMIT DROP AS
  SELECT ws.n AS wsn, ws.id AS ws_id, k, gen_random_uuid() AS id, gen_random_uuid() AS vid
  FROM ws, generate_series(1, 20) k;
INSERT INTO "Workflow" (id, "workspaceId", name, status, "draftDefinition", "draftRevision", "createdAt", "updatedAt")
  SELECT wf.id, wf.ws_id, 'perf workflow ' || wf.k, 'PUBLISHED', def.body, 1,
         now() - (wf.k || ' days')::interval, now()
  FROM wf, def;
INSERT INTO "WorkflowVersion" (id, "workspaceId", "workflowId", version, "schemaVersion", definition, "definitionHash", "publishedAt")
  SELECT wf.vid, wf.ws_id, wf.id, 1, 1, def.body, md5(def.body::text), now() FROM wf, def;
UPDATE "Workflow" w SET "activeVersionId" = wf.vid FROM wf WHERE w.id = wf.id;
INSERT INTO "WorkflowTrigger" (id, "workspaceId", "workflowId", "workflowVersionId", provider, "eventType", "resourceKey", "createdAt")
  SELECT gen_random_uuid(), wf.ws_id, wf.id, wf.vid,
         (CASE WHEN wf.wsn = 1 AND wf.k = 1 THEN 'TEST' ELSE 'GITHUB' END)::"IntegrationProviderKey",
         CASE WHEN wf.wsn = 1 AND wf.k = 1 THEN 'load.event' ELSE 'issues.opened' END,
         CASE WHEN wf.wsn = 1 AND wf.k = 1 THEN 'load-test' ELSE '1000' || wf.wsn || ':perf/repo-' || wf.k END,
         now()
  FROM wf;

INSERT INTO "WebhookDelivery" (id, provider, "deliveryId", "eventType", "workspaceId", status, payload, "receivedAt", "processedAt")
  SELECT gen_random_uuid(), 'GITHUB', 'perf-' || n, 'issues.opened', NULL, 'PROCESSED',
         '{"eventType":"issues.opened","data":{"issue":{"number":1}}}', t, t
  FROM (SELECT n, now() - random() * interval '120 days' AS t
        FROM generate_series(1, (:runs * 3) / 10) n) d;

INSERT INTO "WorkflowRun" (id, "workspaceId", "workflowId", "workflowVersionId", status, "triggerSource",
    "idempotencyKey", "triggerInput", "attemptCount", "lastErrorCategory", "errorMessage",
    "queuedAt", "startedAt", "completedAt", "createdAt", "updatedAt")
  SELECT gen_random_uuid(), wf.ws_id, wf.id, wf.vid,
         (CASE WHEN g.r < 0.90 THEN 'SUCCEEDED' WHEN g.r < 0.97 THEN 'FAILED' ELSE 'CANCELLED' END)::"RunStatus",
         'WEBHOOK', 'perf:' || g.n, '{"issue":{"number":1,"title":"perf"}}', 1,
         (CASE WHEN g.r >= 0.90 AND g.r < 0.97 THEN 'PERMANENT_PROVIDER_ERROR' END)::"ErrorCategory",
         CASE WHEN g.r >= 0.90 AND g.r < 0.97 THEN 'provider rejected the request' END,
         g.t, g.t, g.t + interval '200 milliseconds', g.t, g.t
  FROM (SELECT n,
               CASE WHEN n % 10 < 4 THEN 1 ELSE 2 + (n % (:workspaces - 1)) END AS wsn,
               (n % 20) + 1 AS k,
               now() - random() * interval '120 days' AS t,
               random() AS r
        FROM generate_series(1, :runs) n) g
  JOIN wf ON wf.wsn = g.wsn AND wf.k = g.k;

INSERT INTO "StepRun" (id, "runId", "nodeKey", "nodeType", sequence, status, "attemptCount",
    "sanitizedInput", "sanitizedOutput", "startedAt", "completedAt", "durationMs", "createdAt", "updatedAt")
  SELECT gen_random_uuid(), r.id, s.key, s.type, s.seq,
         (CASE WHEN s.seq = 2 AND r.status = 'FAILED' THEN 'FAILED'
               WHEN s.seq = 2 AND r.status = 'CANCELLED' THEN 'SKIPPED'
               ELSE 'SUCCEEDED' END)::"StepStatus",
         1, '{"message":"load test"}', '{"message":"load test"}',
         r."createdAt", r."createdAt", 5, r."createdAt", r."createdAt"
  FROM "WorkflowRun" r
  CROSS JOIN (VALUES ('trigger', 'manual.trigger', 1), ('log', 'util.log', 2)) AS s(key, type, seq)
  WHERE r."idempotencyKey" LIKE 'perf:%';

COMMIT;
ANALYZE;

SELECT (SELECT count(*) FROM "WorkflowRun") AS runs,
       (SELECT count(*) FROM "StepRun") AS steps,
       (SELECT count(*) FROM "WebhookDelivery") AS deliveries,
       (SELECT count(*) FROM "WorkspaceMember") AS members,
       pg_size_pretty(pg_database_size(current_database())) AS db_size;
