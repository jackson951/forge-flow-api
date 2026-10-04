-- Part 24 slice 3: http.poll trigger (poll schedules and poll state).

-- CreateEnum
CREATE TYPE "ScheduleKind" AS ENUM ('RUN', 'POLL');

-- CreateEnum
CREATE TYPE "PollStatus" AS ENUM ('OK', 'FAILING');

-- AlterEnum
ALTER TYPE "TriggerSource" ADD VALUE 'POLL';

-- AlterTable
ALTER TABLE "WorkflowSchedule" ADD COLUMN     "kind" "ScheduleKind" NOT NULL DEFAULT 'RUN';

-- CreateTable
CREATE TABLE "HttpPollState" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "configHash" TEXT NOT NULL,
    "status" "PollStatus" NOT NULL DEFAULT 'OK',
    "seeded" BOOLEAN NOT NULL DEFAULT false,
    "seenIds" JSONB NOT NULL DEFAULT '[]',
    "lastCursor" TEXT,
    "lastPolledAt" TIMESTAMPTZ(3),
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "itemsFired" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "HttpPollState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HttpPollState_workflowId_key" ON "HttpPollState"("workflowId");

-- CreateIndex
CREATE INDEX "HttpPollState_workspaceId_idx" ON "HttpPollState"("workspaceId");

-- AddForeignKey
ALTER TABLE "HttpPollState" ADD CONSTRAINT "HttpPollState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HttpPollState" ADD CONSTRAINT "HttpPollState_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

