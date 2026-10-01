import { Prisma, PrismaClient, TriggerSource } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

/** Minimal valid rows for integration tests. Each helper accepts overrides. */

const unique = () => randomUUID().slice(0, 8);

export const sampleDefinition = {
  schemaVersion: 1,
  nodes: [
    { key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger', config: {} },
    { key: 'log', kind: 'ACTION', type: 'util.log', config: { message: 'hi' } },
  ],
  edges: [{ from: 'trigger', to: 'log' }],
};

export function createUser(prisma: PrismaClient, data: Partial<Prisma.UserCreateInput> = {}) {
  return prisma.user.create({
    data: {
      email: `user-${unique()}@example.test`,
      name: 'Test User',
      passwordHash: '!test',
      ...data,
    },
  });
}

export async function createWorkspace(prisma: PrismaClient, ownerId?: string) {
  return prisma.workspace.create({
    data: {
      name: `Workspace ${unique()}`,
      ...(ownerId && { members: { create: { userId: ownerId, role: 'OWNER' } } }),
    },
  });
}

export function createWorkflow(prisma: PrismaClient, workspaceId: string) {
  return prisma.workflow.create({
    data: { workspaceId, name: `Workflow ${unique()}`, draftDefinition: sampleDefinition },
  });
}

export function createVersion(
  prisma: PrismaClient,
  workflow: { id: string; workspaceId: string },
  version = 1,
  publishedById?: string,
) {
  return prisma.workflowVersion.create({
    data: {
      workspaceId: workflow.workspaceId,
      workflowId: workflow.id,
      version,
      schemaVersion: 1,
      definition: sampleDefinition,
      definitionHash: createHash('sha256').update(JSON.stringify(sampleDefinition)).digest('hex'),
      publishedById,
    },
  });
}

export function createRun(
  prisma: PrismaClient,
  version: { id: string; workflowId: string; workspaceId: string },
  data: Partial<Prisma.WorkflowRunUncheckedCreateInput> = {},
) {
  return prisma.workflowRun.create({
    data: {
      workspaceId: version.workspaceId,
      workflowId: version.workflowId,
      workflowVersionId: version.id,
      triggerSource: TriggerSource.MANUAL,
      idempotencyKey: randomUUID(),
      ...data,
    },
  });
}
