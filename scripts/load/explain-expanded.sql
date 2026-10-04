-- Hot queries added by Parts 23–26, EXPLAIN (ANALYZE, BUFFERS) on the seeded perf database
-- (Part 27, FR-27.8 / AC-27.4). Statements that write run inside a rolled-back transaction.
\set ON_ERROR_STOP on
\pset pager off
SELECT id AS ws FROM "Workspace" WHERE name = 'perf-1' \gset
SELECT id AS conn_jira FROM "IntegrationConnection" WHERE provider = 'JIRA' ORDER BY id LIMIT 1 \gset
SELECT id AS conn_gmail, "accountLabel" AS mailbox FROM "IntegrationConnection" WHERE provider = 'GMAIL' ORDER BY id LIMIT 1 \gset
SELECT "workflowId" AS hook_wf, "hookIdHash" AS hook_hash FROM "WorkflowWebhook" ORDER BY id LIMIT 1 \gset
SELECT "workflowId" AS sched_wf FROM "WorkflowSchedule" WHERE kind = 'POLL' LIMIT 1 \gset

\echo '== 1. Schedule evaluator: claim a batch of due schedules (FOR UPDATE SKIP LOCKED)'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS)
SELECT s.id, s."workspaceId", s."workflowId", s."workflowVersionId", s.cron, s.timezone, s."nextRunAt", now(),
       w.status, w."activeVersionId", w."workspaceId", s.kind
FROM "WorkflowSchedule" s JOIN "Workflow" w ON w.id = s."workflowId"
WHERE s.active AND s."nextRunAt" <= now()
ORDER BY s."nextRunAt", s.id LIMIT 50
FOR UPDATE OF s SKIP LOCKED;
ROLLBACK;

\echo '== 2. Schedule evaluator: advance a batch of 50 schedules in one statement'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS)
UPDATE "WorkflowSchedule" AS s SET "nextRunAt" = v.next, active = v.active,
  "lastOccurrenceAt" = COALESCE(v.occ, s."lastOccurrenceAt"), "lastRunId" = COALESCE(v.run, s."lastRunId"), "updatedAt" = now()
FROM unnest(
  (SELECT array_agg(id) FROM (SELECT id FROM "WorkflowSchedule" WHERE active AND "nextRunAt" <= now() LIMIT 50) x),
  array_fill(now() + interval '5 minutes', ARRAY[50]), array_fill(true, ARRAY[50]),
  array_fill(now(), ARRAY[50]), array_fill(NULL::uuid, ARRAY[50])
) AS v(id, next, active, occ, run)
WHERE s.id = v.id;
ROLLBACK;

\echo '== 3. Generic webhook intake: hook lookup by hash (current or in-grace previous)'
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM "WorkflowWebhook"
WHERE "hookIdHash" = :'hook_hash' OR ("previousHookIdHash" = :'hook_hash' AND "previousHookIdExpiresAt" > now());

\echo '== 4. Delivery dedup: unique (provider, deliveryId)'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM "WebhookDelivery" WHERE provider = 'WEBHOOK' AND "deliveryId" = 'x:src:42';

\echo '== 5. Delivery log, first page (workflow, newest first)'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, "deliveryId", status, reason, "receivedAt" FROM "WebhookDelivery"
WHERE "workflowId" = :'hook_wf' AND provider = 'WEBHOOK'
ORDER BY "receivedAt" DESC, id DESC LIMIT 21;

\echo '== 6. Delivery log, deep keyset page'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, "deliveryId", status FROM "WebhookDelivery"
WHERE "workflowId" = :'hook_wf' AND provider = 'WEBHOOK'
  AND ("receivedAt" < now() - interval '20 days' OR ("receivedAt" = now() - interval '20 days' AND id < gen_random_uuid()))
ORDER BY "receivedAt" DESC, id DESC LIMIT 21;

\echo '== 7. Jira sync: published triggers of one connection'
EXPLAIN (ANALYZE, BUFFERS)
SELECT t."resourceKey", t.filter, t."workflowVersionId", w."activeVersionId"
FROM "WorkflowTrigger" t JOIN "Workflow" w ON w.id = t."workflowId"
WHERE t.provider = 'JIRA' AND t."connectionId" = :'conn_jira' AND w.status = 'PUBLISHED';

\echo '== 8. Subscription renewal: expiring registrations of one connection'
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM "ProviderSubscription"
WHERE provider = 'JIRA' AND "connectionId" = :'conn_jira' AND cardinality("externalIds") > 0
  AND "expiresAt" < now() + interval '7 days';

\echo '== 9. Gmail push: subscriptions watching a mailbox'
EXPLAIN (ANALYZE, BUFFERS)
SELECT s."connectionId" FROM "ProviderSubscription" s JOIN "IntegrationConnection" c ON c.id = s."connectionId"
WHERE s.provider = 'GMAIL' AND c."accountLabel" = :'mailbox';

\echo '== 10. Poll quota at publish: active polls of a workspace'
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM "WorkflowSchedule"
WHERE "workspaceId" = :'ws' AND kind = 'POLL' AND active AND "workflowId" <> :'sched_wf';

\echo '== 11. Poll state of a workflow'
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM "HttpPollState" WHERE "workflowId" = :'sched_wf';

\echo '== 12. Run list filtered by trigger source (hot tenant)'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, "triggerSource", "createdAt" FROM "WorkflowRun"
WHERE "workspaceId" = :'ws' AND "triggerSource" = 'SCHEDULE'
ORDER BY "createdAt" DESC, id DESC LIMIT 21;

\echo '== 12b. Run list filtered by a rare trigger source (worst case: no match in the tenant)'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, "triggerSource", "createdAt" FROM "WorkflowRun"
WHERE "workspaceId" = :'ws' AND "triggerSource" = 'POLL'
ORDER BY "createdAt" DESC, id DESC LIMIT 21;

\echo '== 13. Retention: oldest deliveries batch (1M+ deliveries)'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM "WebhookDelivery" WHERE "receivedAt" < now() - interval '30 days'
ORDER BY "receivedAt" LIMIT 1000 FOR UPDATE SKIP LOCKED;
ROLLBACK;
