import { ZodTypeAny } from 'zod';
import { aiNodeTypes } from '../../modules/ai/ai.node-types';
import { GITHUB_NODE_TYPES } from '../../modules/integrations/github/github.node-types';
import { MICROSOFT_NODE_TYPES } from '../../modules/integrations/microsoft/microsoft.node-types';
import { SLACK_NODE_TYPES } from '../../modules/integrations/slack/slack.node-types';
import { BUILT_IN_NODE_TYPES } from './node-type-catalog';

/** Every config key a zod schema accepts, through objects, wrappers, arrays and unions. */
function configKeys(schema: ZodTypeAny, prefix = ''): string[] {
  const def = schema._def as Record<string, unknown> & { typeName?: string };
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      return Object.entries(shape).flatMap(([key, value]) => [
        `${prefix}${key}`,
        ...configKeys(value, `${prefix}${key}.`),
      ]);
    }
    case 'ZodEffects':
      return configKeys(def.schema as ZodTypeAny, prefix);
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return configKeys(def.innerType as ZodTypeAny, prefix);
    case 'ZodArray':
      return configKeys(def.type as ZodTypeAny, `${prefix}[].`);
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      return (def.options as ZodTypeAny[]).flatMap((o) => configKeys(o, prefix));
    case 'ZodLazy':
      return []; // recursive condition trees: data operands only
    default:
      return [];
  }
}

/**
 * Part 18, FR-18.7: no node lets a workflow author choose where FlowForge sends requests.
 * Provider endpoints are server configuration. A node with a URL-like setting must first
 * implement the SSRF policy in docs/backend/18-RATE-LIMITING-AND-API-HARDENING.md, and
 * then be added here deliberately.
 */
describe('no user-configurable outbound URLs (SSRF)', () => {
  const nodeTypes = [
    ...BUILT_IN_NODE_TYPES,
    ...GITHUB_NODE_TYPES,
    ...SLACK_NODE_TYPES,
    ...MICROSOFT_NODE_TYPES,
    ...aiNodeTypes(true),
  ];

  it('inspects every node type', () => {
    expect(nodeTypes.length).toBeGreaterThanOrEqual(9);
    expect(configKeys(SLACK_NODE_TYPES[0].configSchema)).toEqual(
      expect.arrayContaining(['connectionId', 'channelId', 'text']),
    );
  });

  it.each(nodeTypes.map((t) => [t.type, t] as const))('%s has no URL/host setting', (_type, t) => {
    const urlish = configKeys(t.configSchema).filter((k) =>
      /(^|\.)(url|uri|href|endpoint|host|hostname|baseurl|webhook)[^.]*$/i.test(k),
    );
    expect(urlish).toEqual([]);
  });
});
