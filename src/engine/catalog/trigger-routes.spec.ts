import { z } from 'zod';
import { WorkflowDefinition } from '../definition/definition.schema';
import { NodeTypeCatalog } from './node-type-catalog';
import { deriveTriggerRoutes } from './trigger-routes';

const catalog = new NodeTypeCatalog();
catalog.register({
  type: 'test.webhook',
  kind: 'TRIGGER',
  displayName: 'Test webhook',
  configSchema: z.object({ resource: z.string() }).strict(),
  route: (config) => ({
    provider: 'GITHUB',
    eventType: 'test.event',
    resourceKey: String(config.resource),
  }),
});

const withTrigger = (type: string, config: Record<string, unknown>): WorkflowDefinition => ({
  schemaVersion: 1,
  nodes: [
    { key: 'trigger', kind: 'TRIGGER', type, config },
    { key: 'log', kind: 'ACTION', type: 'util.log', config: { message: 'x' } },
  ],
  edges: [{ from: 'trigger', to: 'log' }],
});

describe('deriveTriggerRoutes', () => {
  it('returns the routing entry of a webhook trigger', () => {
    expect(
      deriveTriggerRoutes(withTrigger('test.webhook', { resource: 'owner/repo' }), catalog),
    ).toEqual([{ provider: 'GITHUB', eventType: 'test.event', resourceKey: 'owner/repo' }]);
  });

  it('returns nothing for a manual trigger', () => {
    expect(deriveTriggerRoutes(withTrigger('manual.trigger', {}), catalog)).toEqual([]);
  });

  it('rejects registering the same type twice', () => {
    expect(() =>
      catalog.register({
        type: 'test.webhook',
        kind: 'TRIGGER',
        displayName: 'dup',
        configSchema: z.object({}),
      }),
    ).toThrow(/already registered/);
  });
});
