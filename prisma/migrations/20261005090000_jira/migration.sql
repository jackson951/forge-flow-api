-- Part 25: Jira Cloud. Connection status reasons, routing filters, provider subscriptions.

-- CreateEnum
CREATE TYPE "ConnectionStatusReason" AS ENUM ('TOKEN_REVOKED', 'TOKEN_EXPIRED', 'APP_UNINSTALLED', 'PERMISSION_CHANGED', 'WATCH_RENEWAL_FAILED', 'AUTHENTICATION_FAILED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'FAILING');

-- AlterEnum
ALTER TYPE "IntegrationProviderKey" ADD VALUE 'JIRA';

-- AlterTable
ALTER TABLE "WorkflowTrigger" ADD COLUMN     "filter" JSONB;

-- AlterTable
ALTER TABLE "IntegrationConnection" ADD COLUMN     "statusReason" "ConnectionStatusReason";

-- CreateTable
CREATE TABLE "ProviderSubscription" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "provider" "IntegrationProviderKey" NOT NULL,
    "resourceKey" TEXT NOT NULL,
    "externalIds" TEXT[],
    "details" JSONB NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMPTZ(3),
    "lastRenewedAt" TIMESTAMPTZ(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProviderSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderSubscription_expiresAt_idx" ON "ProviderSubscription"("expiresAt");

-- CreateIndex
CREATE INDEX "ProviderSubscription_workspaceId_idx" ON "ProviderSubscription"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderSubscription_connectionId_resourceKey_key" ON "ProviderSubscription"("connectionId", "resourceKey");

-- AddForeignKey
ALTER TABLE "ProviderSubscription" ADD CONSTRAINT "ProviderSubscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderSubscription" ADD CONSTRAINT "ProviderSubscription_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

