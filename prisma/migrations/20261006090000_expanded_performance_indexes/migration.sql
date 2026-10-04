-- Part 27: indexes found by scripts/load/explain-expanded.sql on the expanded-platform seed.
-- (A plain CREATE INDEX blocks writes to the table while it builds: on a large production
-- "WorkflowRun", build it beforehand with CREATE INDEX CONCURRENTLY under the same name.)

-- Run list filtered by trigger source: 1357 ms → 2 ms for a rare source on a 121k-run tenant.
CREATE INDEX "WorkflowRun_workspaceId_triggerSource_createdAt_idx" ON "WorkflowRun"("workspaceId", "triggerSource", "createdAt");

-- Jira/Gmail sync: published triggers of one connection (was a sequential scan).
CREATE INDEX "WorkflowTrigger_connectionId_idx" ON "WorkflowTrigger"("connectionId");

-- Gmail push: connections watching a mailbox, on every notification (was a sequential scan).
CREATE INDEX "IntegrationConnection_accountLabel_idx" ON "IntegrationConnection"("accountLabel");
