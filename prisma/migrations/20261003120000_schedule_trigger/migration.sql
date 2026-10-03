-- Part 23: schedule trigger. WorkflowSchedule holds the active version's time trigger; the
-- unique WorkflowRun(workspaceId, idempotencyKey) keeps one run per occurrence.

-- AlterEnum
ALTER TYPE "TriggerSource" ADD VALUE 'SCHEDULE';

-- CreateTable
CREATE TABLE "WorkflowSchedule" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "workflowVersionId" UUID NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "description" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMPTZ(3),
    "lastOccurrenceAt" TIMESTAMPTZ(3),
    "lastRunId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkflowSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowSchedule_workflowId_key" ON "WorkflowSchedule"("workflowId");

-- CreateIndex
CREATE INDEX "WorkflowSchedule_active_nextRunAt_idx" ON "WorkflowSchedule"("active", "nextRunAt");

-- CreateIndex
CREATE INDEX "WorkflowSchedule_workspaceId_idx" ON "WorkflowSchedule"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkflowSchedule_workflowVersionId_idx" ON "WorkflowSchedule"("workflowVersionId");

-- AddForeignKey
ALTER TABLE "WorkflowSchedule" ADD CONSTRAINT "WorkflowSchedule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowSchedule" ADD CONSTRAINT "WorkflowSchedule_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowSchedule" ADD CONSTRAINT "WorkflowSchedule_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

