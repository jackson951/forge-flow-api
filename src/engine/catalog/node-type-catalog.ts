import { IntegrationProviderKey } from '@prisma/client';
import { z, ZodType } from 'zod';
import { NodeKind } from '../definition/definition.schema';
import { conditionConfigSchema } from '../expressions/conditions';
import type { ScheduleSpec } from '../schedule/schedule';

/** Where a webhook-driven trigger listens; stored as a WorkflowTrigger row on publish. */
export interface TriggerRoute {
  provider: IntegrationProviderKey;
  eventType: string;
  /** Provider-specific routing key, e.g. "<installationId>:owner/repo". */
  resourceKey: string;
  connectionId?: string;
}

/** Static description of a node type: what config it accepts. Handlers (Part 08) are separate. */
export interface NodeTypeDefinition {
  type: string;
  kind: NodeKind;
  displayName: string;
  configSchema: ZodType;
  /**
   * Webhook triggers only: maps validated config to its routing entry. Triggers without
   * it (e.g. manual.trigger) are started through the API instead.
   */
  route?: (config: Record<string, unknown>) => TriggerRoute;
  /**
   * Time-based triggers only (Part 23): maps validated config to its schedule, stored as a
   * WorkflowSchedule row on publish.
   */
  schedule?: (config: Record<string, unknown>) => ScheduleSpec;
  /**
   * Nodes that act through an integration: their config's `connectionId` must reference a
   * CONNECTED connection of this provider in the workflow's own workspace (checked on publish).
   */
  connectionProvider?: IntegrationProviderKey;
  /**
   * Set when this server cannot run the node type (e.g. no AI provider configured): drafts
   * may contain it, but publishing fails with PROVIDER_NOT_CONFIGURED.
   */
  unavailableReason?: string;
}

// ── Built-in node types ──────────────────────────────────────────────────────

export const BUILT_IN_NODE_TYPES: NodeTypeDefinition[] = [
  {
    type: 'manual.trigger',
    kind: 'TRIGGER',
    displayName: 'Manual trigger',
    configSchema: z.object({}).strict(),
  },
  {
    type: 'condition',
    kind: 'CONDITION',
    displayName: 'Condition',
    configSchema: conditionConfigSchema,
  },
  {
    type: 'util.log',
    kind: 'ACTION',
    displayName: 'Log message',
    configSchema: z.object({ message: z.string().min(1).max(1000) }).strict(),
  },
];

/** Registry of node types; integration parts register theirs at startup. */
export class NodeTypeCatalog {
  private readonly types = new Map<string, NodeTypeDefinition>();

  constructor(definitions: NodeTypeDefinition[] = BUILT_IN_NODE_TYPES) {
    definitions.forEach((d) => this.register(d));
  }

  register(definition: NodeTypeDefinition): void {
    if (this.types.has(definition.type)) {
      throw new Error(`Node type "${definition.type}" is already registered`);
    }
    this.types.set(definition.type, definition);
  }

  get(type: string): NodeTypeDefinition | undefined {
    return this.types.get(type);
  }

  list(): NodeTypeDefinition[] {
    return [...this.types.values()];
  }
}
