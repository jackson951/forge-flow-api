-- Expanded-platform seed (Part 27). Run AFTER seed-perf.sql, on the throwaway perf database
-- only (NEVER a real one):
--
--   psql -v deliveries=1000000 -f scripts/load/seed-expanded.sql
--
-- Adds, across the perf-* workspaces: 10 000 schedule workflows (30 % due at the same minute,
-- 10 % http.poll, 5 % inactive), 5 000 generic webhooks, 2 000 Jira/Gmail connections with
-- provider subscriptions and Jira trigger routing, `deliveries` generic-webhook deliveries over
-- 30 days, 1 000 poll states with full 2 000-id seen windows, and 100 000 SCHEDULE/POLL runs.
\set ON_ERROR_STOP on
\if :{?deliveries} \else \set deliveries 1000000 \endif

SET synchronous_commit = off;
\timing on
BEGIN;

CREATE TEMP TABLE ws ON COMMIT DROP AS
  SELECT row_number() OVER (ORDER BY name) AS n, id FROM "Workspace" WHERE name LIKE 'perf-%';

CREATE TEMP TABLE def ON COMMIT DROP AS SELECT
  '{"schemaVersion":1,"nodes":[{"key":"trigger","kind":"TRIGGER","type":"schedule.trigger","config":{"schedule":{"kind":"interval","timezone":"UTC","everyMinutes":5}}},{"key":"log","kind":"ACTION","type":"util.log","config":{"message":"tick"}}],"edges":[{"from":"trigger","to":"log"}]}'::jsonb AS body;

-- 10 000 schedule workflows (100 per workspace for 100 workspaces).
CREATE TEMP TABLE sw ON COMMIT DROP AS
  SELECT g AS k, ws.id AS ws_id, gen_random_uuid() AS id, gen_random_uuid() AS vid
  FROM generate_series(1, 10000) g JOIN ws ON ws.n = (g % (SELECT count(*) FROM ws)) + 1;
INSERT INTO "Workflow" (id, "workspaceId", name, status, "draftDefinition", "draftRevision", "createdAt", "updatedAt")
  SELECT sw.id, sw.ws_id, 'scheduled ' || sw.k, 'PUBLISHED', def.body, 1, now(), now() FROM sw, def;
INSERT INTO "WorkflowVersion" (id, "workspaceId", "workflowId", version, "schemaVersion", definition, "definitionHash", "publishedAt")
  SELECT sw.vid, sw.ws_id, sw.id, 1, 1, def.body, md5(def.body::text), now() FROM sw, def;
UPDATE "Workflow" w SET "activeVersionId" = sw.vid FROM sw WHERE w.id = sw.id;
INSERT INTO "WorkflowSchedule" (id, "workspaceId", "workflowId", "workflowVersionId", cron, timezone, config, description, active, kind, "nextRunAt", "createdAt", "updatedAt")
  SELECT gen_random_uuid(), sw.ws_id, sw.id, sw.vid, '*/5 * * * *',
         (ARRAY['UTC', 'Africa/Johannesburg', 'America/New_York'])[(sw.k % 3) + 1],
         def.body -> 'nodes' -> 0 -> 'config', 'Every 5 minutes',
         sw.k % 20 <> 0,
         (CASE WHEN sw.k % 10 = 0 THEN 'POLL' ELSE 'RUN' END)::"ScheduleKind",
         CASE WHEN sw.k % 10 < 3 THEN date_trunc('minute', now())
              ELSE now() + (sw.k % 2016) * interval '5 minutes' END,
         now(), now()
  FROM sw, def;

-- 5 000 generic webhooks on existing perf workflows.
INSERT INTO "WorkflowWebhook" (id, "workspaceId", "workflowId", "workflowVersionId", "hookIdHash", "encryptedHookId", config, active, "createdAt", "updatedAt")
  SELECT gen_random_uuid(), w."workspaceId", w.id, w."activeVersionId", encode(sha256(w.id::text::bytea), 'hex'), 'sealed',
         '{"methods":["POST"],"verification":{"mode":"token"}}', true, now(), now()
  FROM (SELECT * FROM "Workflow" WHERE name LIKE 'scheduled %' ORDER BY id LIMIT 5000) w;

-- 2 000 connections (half Jira, half Gmail) with subscriptions; 1 000 perf triggers routed to Jira.
CREATE TEMP TABLE conn ON COMMIT DROP AS
  SELECT g AS k, ws.id AS ws_id, gen_random_uuid() AS id FROM generate_series(1, 2000) g
  JOIN ws ON ws.n = (g % (SELECT count(*) FROM ws)) + 1;
INSERT INTO "IntegrationConnection" (id, "workspaceId", provider, status, "externalAccountId", "accountLabel", scopes, metadata, "createdAt", "updatedAt")
  SELECT id, ws_id, (CASE WHEN k % 2 = 0 THEN 'JIRA' ELSE 'GMAIL' END)::"IntegrationProviderKey", 'CONNECTED',
         'acct-' || k, 'mailbox-' || (k % 1500) || '@perf.test', '{}', '{}', now(), now()
  FROM conn;
INSERT INTO "ProviderSubscription" (id, "workspaceId", "connectionId", provider, "resourceKey", "externalIds", details, status, "expiresAt", "lastRenewedAt", "createdAt", "updatedAt")
  SELECT gen_random_uuid(), ws_id, id, (CASE WHEN k % 2 = 0 THEN 'JIRA' ELSE 'GMAIL' END)::"IntegrationProviderKey",
         CASE WHEN k % 2 = 0 THEN 'cloud-' || k ELSE 'mailbox' END, ARRAY[k::text],
         '{"jql":"project IN (\"ENG\")","historyId":"1000"}', 'ACTIVE',
         now() + (k % 30) * interval '1 day', now(), now(), now()
  FROM conn;
UPDATE "WorkflowTrigger" t SET provider = 'JIRA', "eventType" = 'jira.issue.created', "resourceKey" = 'cloud-' || c.k,
       "connectionId" = c.id, filter = '{"projectKeys":["ENG"]}'
  FROM (SELECT t2.id, row_number() OVER (ORDER BY t2.id) AS rn FROM "WorkflowTrigger" t2 WHERE t2.provider = 'GITHUB' LIMIT 1000) pick
  JOIN conn c ON c.k = pick.rn * 2
  WHERE t.id = pick.id;

-- Generic-webhook deliveries over 30 days (the delivery log and retention read these).
INSERT INTO "WebhookDelivery" (id, provider, "deliveryId", "eventType", "workspaceId", "workflowId", status, reason, "sizeBytes", "sourceIp", payload, "receivedAt", "processedAt")
  SELECT gen_random_uuid(), 'WEBHOOK', h.id || ':src:' || g.n, 'webhook.received', h."workspaceId", h."workflowId",
         (CASE WHEN g.r < 0.85 THEN 'PROCESSED' WHEN g.r < 0.95 THEN 'IGNORED' ELSE 'REJECTED' END)::"WebhookDeliveryStatus",
         CASE WHEN g.r >= 0.95 THEN 'token mismatch' WHEN g.r >= 0.85 THEN 'filter did not match' END,
         512, '203.0.113.7', '{"method":"POST","body":{"n":1}}', g.t, g.t
  FROM (SELECT n, (n % 5000) + 1 AS hk, now() - random() * interval '30 days' AS t, random() AS r
        FROM generate_series(1, :deliveries) n) g
  JOIN (SELECT row_number() OVER (ORDER BY id) AS hk, id, "workspaceId", "workflowId" FROM "WorkflowWebhook") h ON h.hk = g.hk;

-- 1 000 poll states with a full seen window.
INSERT INTO "HttpPollState" (id, "workspaceId", "workflowId", "configHash", status, seeded, "seenIds", "lastPolledAt", "itemsFired", "createdAt", "updatedAt")
  SELECT gen_random_uuid(), w."workspaceId", w.id, md5(w.id::text), 'OK', true,
         (SELECT jsonb_agg('item-' || i) FROM generate_series(1, 2000) i), now(), 2000, now(), now()
  FROM (SELECT * FROM "Workflow" WHERE name LIKE 'scheduled %' ORDER BY id DESC LIMIT 1000) w;

-- 100 000 SCHEDULE / POLL runs (run list filters by trigger source).
INSERT INTO "WorkflowRun" (id, "workspaceId", "workflowId", "workflowVersionId", status, "triggerSource", "idempotencyKey", "triggerInput", "attemptCount", "queuedAt", "startedAt", "completedAt", "createdAt", "updatedAt")
  SELECT gen_random_uuid(), sw.ws_id, sw.id, sw.vid, 'SUCCEEDED',
         (CASE WHEN g % 10 = 0 THEN 'POLL' ELSE 'SCHEDULE' END)::"TriggerSource",
         'schedule:' || sw.id || ':' || g, '{"triggerType":"SCHEDULE"}', 1, t, t, t, t, t
  FROM (SELECT g, (g % 10000) + 1 AS k, now() - random() * interval '60 days' AS t FROM generate_series(1, 100000) g) x
  JOIN sw ON sw.k = x.k;

COMMIT;
ANALYZE;

SELECT (SELECT count(*) FROM "WorkflowRun") AS runs,
       (SELECT count(*) FROM "WorkflowSchedule") AS schedules,
       (SELECT count(*) FROM "WorkflowSchedule" WHERE active AND "nextRunAt" <= now()) AS due_now,
       (SELECT count(*) FROM "WebhookDelivery") AS deliveries,
       (SELECT count(*) FROM "WorkflowWebhook") AS hooks,
       (SELECT count(*) FROM "ProviderSubscription") AS subscriptions,
       (SELECT count(*) FROM "HttpPollState") AS poll_states,
       pg_size_pretty(pg_database_size(current_database())) AS db_size;
