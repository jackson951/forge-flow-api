/**
 * Serializable, versioned workflow definition (scope §11).
 * A published WorkflowVersion stores one of these immutably.
 */
export interface TriggerDefinition {
  type: string; // e.g. 'github.issue.created'
  config: Record<string, unknown>;
}

export interface NodeDefinition {
  id: string;
  type: string; // e.g. 'ai.classify', 'condition', 'slack.sendMessage'
  config: Record<string, unknown>;
}

export interface EdgeDefinition {
  from: string; // 'trigger' or a node id
  to: string;
  branch?: 'true' | 'false';
}

export interface WorkflowDefinition {
  trigger: TriggerDefinition;
  nodes: NodeDefinition[];
  edges: EdgeDefinition[];
}
