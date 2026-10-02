-- Part 21: retention marker and indexes for history clean-up.

-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN     "payloadsTrimmedAt" TIMESTAMPTZ(3);

-- CreateIndex
-- Deleting runs sets "retryOfRunId" to NULL on their retries; without this index each deleted
-- run costs a full scan of WorkflowRun.
CREATE INDEX "WorkflowRun_retryOfRunId_idx" ON "WorkflowRun"("retryOfRunId");

-- CreateIndex
CREATE INDEX "WorkflowRun_payloadsTrimmedAt_createdAt_idx" ON "WorkflowRun"("payloadsTrimmedAt", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_createdAt_idx" ON "WorkflowRun"("createdAt");
