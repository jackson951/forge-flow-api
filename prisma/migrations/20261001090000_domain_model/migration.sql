-- Part 02 domain model (docs/backend/02-DATABASE-DOMAIN-MODEL.md).
-- Pre-release: assumes no production data in the scaffold tables it drops/alters.

-- CreateEnum
CREATE TYPE "TriggerSource" AS ENUM ('WEBHOOK', 'MANUAL', 'RETRY');

-- CreateEnum
CREATE TYPE "ErrorCategory" AS ENUM ('VALIDATION', 'AUTHORIZATION', 'PROVIDER_AUTH', 'PROVIDER_RATE_LIMIT', 'PROVIDER_TIMEOUT', 'TRANSIENT_INFRASTRUCTURE', 'PERMANENT_PROVIDER_ERROR', 'UNCERTAIN_OUTCOME', 'CANCELLED', 'INTERNAL');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- AlterEnum
BEGIN;
CREATE TYPE "WorkflowStatus_new" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
ALTER TABLE "public"."Workflow" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Workflow" ALTER COLUMN "status" TYPE "WorkflowStatus_new" USING ("status"::text::"WorkflowStatus_new");
ALTER TYPE "WorkflowStatus" RENAME TO "WorkflowStatus_old";
ALTER TYPE "WorkflowStatus_new" RENAME TO "WorkflowStatus";
DROP TYPE "public"."WorkflowStatus_old";
ALTER TABLE "Workflow" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
COMMIT;

-- DropForeignKey
ALTER TABLE "Session" DROP CONSTRAINT "Session_userId_fkey";

-- DropForeignKey
ALTER TABLE "WebhookEvent" DROP CONSTRAINT "WebhookEvent_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "Workflow" DROP CONSTRAINT "Workflow_publishedVersionId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowEdge" DROP CONSTRAINT "WorkflowEdge_versionId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowNode" DROP CONSTRAINT "WorkflowNode_versionId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowRun" DROP CONSTRAINT "WorkflowRun_versionId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowRun" DROP CONSTRAINT "WorkflowRun_webhookEventId_fkey";

-- DropIndex
DROP INDEX "Workflow_publishedVersionId_key";

-- DropIndex
DROP INDEX "Workflow_workspaceId_status_idx";

-- DropIndex
DROP INDEX "WorkflowRun_versionId_idx";

-- DropIndex
DROP INDEX "WorkflowRun_webhookEventId_key";

-- DropIndex
DROP INDEX "WorkflowRun_workspaceId_status_queuedAt_idx";

-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "ipHash" TEXT,
ALTER COLUMN "workspaceId" DROP NOT NULL,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "IntegrationConnection" DROP COLUMN "encryptedAccessToken",
DROP COLUMN "encryptedRefreshToken",
DROP COLUMN "tokenExpiresAt",
ADD COLUMN     "accountLabel" TEXT,
ADD COLUMN     "createdById" UUID,
ADD COLUMN     "lastUsedAt" TIMESTAMPTZ(3),
ADD COLUMN     "metadata" JSONB,
ALTER COLUMN "externalAccountId" SET NOT NULL,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "StepRun" DROP COLUMN "attempt",
DROP COLUMN "finishedAt",
DROP COLUMN "inputMeta",
DROP COLUMN "outputMeta",
ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "completedAt" TIMESTAMPTZ(3),
ADD COLUMN     "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "errorCategory" "ErrorCategory",
ADD COLUMN     "externalRef" TEXT,
ADD COLUMN     "nodeType" TEXT NOT NULL,
ADD COLUMN     "sanitizedInput" JSONB,
ADD COLUMN     "sanitizedOutput" JSONB,
ADD COLUMN     "updatedAt" TIMESTAMPTZ(3) NOT NULL,
ALTER COLUMN "startedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "passwordHash" SET NOT NULL,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Workflow" DROP COLUMN "publishedVersionId",
ADD COLUMN     "activeVersionId" UUID,
ADD COLUMN     "createdById" UUID,
ADD COLUMN     "draftRevision" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "draftDefinition" SET NOT NULL,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "WorkflowRun" DROP COLUMN "finishedAt",
DROP COLUMN "triggerPayload",
DROP COLUMN "versionId",
DROP COLUMN "webhookEventId",
ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cancelRequestedAt" TIMESTAMPTZ(3),
ADD COLUMN     "completedAt" TIMESTAMPTZ(3),
ADD COLUMN     "correlationId" TEXT,
ADD COLUMN     "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "idempotencyKey" TEXT NOT NULL,
ADD COLUMN     "lastErrorCategory" "ErrorCategory",
ADD COLUMN     "lockedBy" TEXT,
ADD COLUMN     "retryOfRunId" UUID,
ADD COLUMN     "triggerInput" JSONB,
ADD COLUMN     "triggerSource" "TriggerSource" NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMPTZ(3) NOT NULL,
ADD COLUMN     "webhookDeliveryId" UUID,
ADD COLUMN     "workflowId" UUID NOT NULL,
ADD COLUMN     "workflowVersionId" UUID NOT NULL,
ALTER COLUMN "queuedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "startedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "WorkflowVersion" ADD COLUMN     "definitionHash" TEXT NOT NULL,
ADD COLUMN     "publishedById" UUID,
ADD COLUMN     "schemaVersion" INTEGER NOT NULL,
ADD COLUMN     "workspaceId" UUID NOT NULL,
ALTER COLUMN "publishedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Workspace" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "WorkspaceMember" ADD COLUMN     "updatedAt" TIMESTAMPTZ(3) NOT NULL,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- DropTable
DROP TABLE "Session";

-- DropTable
DROP TABLE "WebhookEvent";

-- DropTable
DROP TABLE "WorkflowEdge";

-- DropTable
DROP TABLE "WorkflowNode";

-- DropEnum
DROP TYPE "NodeKind";

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "replacedById" UUID,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowTrigger" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "workflowVersionId" UUID NOT NULL,
    "provider" "IntegrationProviderKey" NOT NULL,
    "eventType" TEXT NOT NULL,
    "resourceKey" TEXT NOT NULL,
    "connectionId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationCredential" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "keyId" TEXT NOT NULL,
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "id" UUID NOT NULL,
    "stateHash" TEXT NOT NULL,
    "provider" "IntegrationProviderKey" NOT NULL,
    "userId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "encryptedCodeVerifier" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "provider" "IntegrationProviderKey" NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "workspaceId" UUID,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'RECEIVED',
    "payload" JSONB,
    "errorMessage" TEXT,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_replacedById_key" ON "RefreshToken"("replacedById");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTrigger_workflowId_key" ON "WorkflowTrigger"("workflowId");

-- CreateIndex
CREATE INDEX "WorkflowTrigger_provider_eventType_resourceKey_idx" ON "WorkflowTrigger"("provider", "eventType", "resourceKey");

-- CreateIndex
CREATE INDEX "WorkflowTrigger_workspaceId_idx" ON "WorkflowTrigger"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationCredential_connectionId_key" ON "IntegrationCredential"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthState_stateHash_key" ON "OAuthState"("stateHash");

-- CreateIndex
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_receivedAt_idx" ON "WebhookDelivery"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_provider_deliveryId_key" ON "WebhookDelivery"("provider", "deliveryId");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_createdAt_idx" ON "AuditEvent"("actorUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StepRun_runId_nodeKey_key" ON "StepRun"("runId", "nodeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_activeVersionId_key" ON "Workflow"("activeVersionId");

-- CreateIndex
CREATE INDEX "Workflow_workspaceId_status_updatedAt_idx" ON "Workflow"("workspaceId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_workspaceId_createdAt_idx" ON "WorkflowRun"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_workspaceId_status_createdAt_idx" ON "WorkflowRun"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_workflowId_createdAt_idx" ON "WorkflowRun"("workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_status_queuedAt_idx" ON "WorkflowRun"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_webhookDeliveryId_idx" ON "WorkflowRun"("webhookDeliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRun_workspaceId_idempotencyKey_key" ON "WorkflowRun"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "WorkflowVersion_workspaceId_idx" ON "WorkflowVersion"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "RefreshToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTrigger" ADD CONSTRAINT "WorkflowTrigger_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTrigger" ADD CONSTRAINT "WorkflowTrigger_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTrigger" ADD CONSTRAINT "WorkflowTrigger_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTrigger" ADD CONSTRAINT "WorkflowTrigger_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_webhookDeliveryId_fkey" FOREIGN KEY ("webhookDeliveryId") REFERENCES "WebhookDelivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_retryOfRunId_fkey" FOREIGN KEY ("retryOfRunId") REFERENCES "WorkflowRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationCredential" ADD CONSTRAINT "IntegrationCredential_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Raw SQL: constraints Prisma cannot express ──────────────────────────────

-- Emails are normalised to lower case by the application; the database refuses anything else
-- so the unique index is effectively case-insensitive.
ALTER TABLE "User" ADD CONSTRAINT "User_email_lowercase_check" CHECK ("email" = lower("email"));

ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_version_positive_check" CHECK ("version" >= 1);
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_schemaVersion_positive_check" CHECK ("schemaVersion" >= 1);
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_attemptCount_check" CHECK ("attemptCount" >= 0);
ALTER TABLE "StepRun" ADD CONSTRAINT "StepRun_attemptCount_check" CHECK ("attemptCount" >= 0);

-- Published versions are immutable: the snapshot columns can never change after insert.
-- (publishedById may still be set to NULL when the publishing user is deleted.)
CREATE FUNCTION "workflow_version_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."definition" IS DISTINCT FROM OLD."definition"
     OR NEW."definitionHash" IS DISTINCT FROM OLD."definitionHash"
     OR NEW."schemaVersion" IS DISTINCT FROM OLD."schemaVersion"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."workflowId" IS DISTINCT FROM OLD."workflowId"
     OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
     OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt" THEN
    RAISE EXCEPTION 'WorkflowVersion % is immutable', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WorkflowVersion_immutable"
  BEFORE UPDATE ON "WorkflowVersion"
  FOR EACH ROW EXECUTE FUNCTION "workflow_version_immutable"();
