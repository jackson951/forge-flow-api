import { NodeTypeDefinition } from '../../engine/catalog/node-type-catalog';
import { NodeHandler } from '../../engine/execution/node-handler';
import { webhookTriggerConfigSchema, WebhookTriggerConfig } from './hook-config';

export const WEBHOOK_TRIGGER = 'webhook.received';

/** Generic inbound webhook trigger (Part 24). Publishing provisions /webhooks/hooks/:hookId. */
export const WEBHOOK_NODE_TYPES: NodeTypeDefinition[] = [
  {
    type: WEBHOOK_TRIGGER,
    kind: 'TRIGGER',
    displayName: 'Webhook',
    configSchema: webhookTriggerConfigSchema,
    webhook: (config) => config as WebhookTriggerConfig,
  },
];

/** Its output is the normalised delivery stored as the run's trigger input. */
export const WEBHOOK_HANDLERS: NodeHandler[] = [
  {
    type: WEBHOOK_TRIGGER,
    kind: 'TRIGGER',
    sideEffect: 'none',
    execute: async ({ triggerInput }) => ({ output: triggerInput ?? {} }),
  },
];
