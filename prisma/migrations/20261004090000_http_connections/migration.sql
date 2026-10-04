-- Part 24: generic HTTP connections. Secrets live sealed in IntegrationCredential.encryptedPayload.

-- AlterEnum
ALTER TYPE "IntegrationProviderKey" ADD VALUE 'HTTP';

-- AlterTable
ALTER TABLE "IntegrationCredential" ADD COLUMN     "encryptedPayload" TEXT;

