-- Part 24 slice 2: generic inbound webhooks (WorkflowWebhook) and delivery log fields.

-- AlterEnum
ALTER TYPE "IntegrationProviderKey" ADD VALUE 'WEBHOOK';

-- AlterEnum
ALTER TYPE "WebhookDeliveryStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "WebhookDelivery" ADD COLUMN     "duplicateCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastDuplicateAt" TIMESTAMPTZ(3),
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "sizeBytes" INTEGER,
ADD COLUMN     "sourceIp" TEXT,
ADD COLUMN     "workflowId" UUID;

-- CreateTable
CREATE TABLE "WorkflowWebhook" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "workflowVersionId" UUID,
    "hookIdHash" TEXT NOT NULL,
    "encryptedHookId" TEXT NOT NULL,
    "previousHookIdHash" TEXT,
    "previousHookIdExpiresAt" TIMESTAMPTZ(3),
    "config" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "encryptedSecret" TEXT,
    "secretHint" TEXT,
    "secretRevealedAt" TIMESTAMPTZ(3),
    "previousEncryptedSecret" TEXT,
    "previousSecretExpiresAt" TIMESTAMPTZ(3),
    "rotatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkflowWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowWebhook_workflowId_key" ON "WorkflowWebhook"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowWebhook_hookIdHash_key" ON "WorkflowWebhook"("hookIdHash");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowWebhook_previousHookIdHash_key" ON "WorkflowWebhook"("previousHookIdHash");

-- CreateIndex
CREATE INDEX "WorkflowWebhook_workspaceId_idx" ON "WorkflowWebhook"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkflowWebhook_workflowVersionId_idx" ON "WorkflowWebhook"("workflowVersionId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_workflowId_receivedAt_idx" ON "WebhookDelivery"("workflowId", "receivedAt");

-- AddForeignKey
ALTER TABLE "WorkflowWebhook" ADD CONSTRAINT "WorkflowWebhook_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowWebhook" ADD CONSTRAINT "WorkflowWebhook_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowWebhook" ADD CONSTRAINT "WorkflowWebhook_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

