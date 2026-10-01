import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NodeTypeCatalog } from '../../engine/catalog/node-type-catalog';
import { deriveTriggerRoutes } from '../../engine/catalog/trigger-routes';
import { parseDefinition } from '../../engine/definition/definition.schema';

/**
 * Keeps the WorkflowTrigger routing table in step with a workflow's active version.
 * Always called inside the transaction that changes the active version or the status.
 */
@Injectable()
export class TriggerRoutingService {
  constructor(private readonly catalog: NodeTypeCatalog) {}

  async activate(
    tx: Prisma.TransactionClient,
    workflow: { id: string; workspaceId: string },
    version: { id: string; definition: unknown },
  ): Promise<void> {
    const parsed = parseDefinition(version.definition);
    if (!parsed.ok) throw new Error(`Stored version ${version.id} does not match the schema`);

    await this.deactivate(tx, workflow.id);
    const routes = deriveTriggerRoutes(parsed.definition, this.catalog);
    if (routes.length) {
      await tx.workflowTrigger.createMany({
        data: routes.map((route) => ({
          ...route,
          workspaceId: workflow.workspaceId,
          workflowId: workflow.id,
          workflowVersionId: version.id,
        })),
      });
    }
  }

  async deactivate(tx: Prisma.TransactionClient, workflowId: string): Promise<void> {
    await tx.workflowTrigger.deleteMany({ where: { workflowId } });
  }
}
