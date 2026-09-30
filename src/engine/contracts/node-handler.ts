import { NodeDefinition } from './workflow-definition';

export interface StepContext {
  runId: string;
  workspaceId: string;
  node: NodeDefinition;
  /** Outputs of previously executed steps, keyed by node id. */
  outputs: Record<string, unknown>;
  triggerPayload: unknown;
}

export type StepResult =
  | { status: 'succeeded'; output: unknown; branch?: 'true' | 'false' }
  | { status: 'failed'; error: string; retryable: boolean };

/** Every trigger/action/condition node type implements this contract. */
export interface NodeHandler {
  readonly type: string;
  execute(context: StepContext): Promise<StepResult>;
}
