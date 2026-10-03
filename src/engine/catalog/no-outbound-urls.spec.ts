import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZodTypeAny } from 'zod';
import { aiNodeTypes } from '../../modules/ai/ai.node-types';
import { GITHUB_NODE_TYPES } from '../../modules/integrations/github/github.node-types';
import { httpNodeTypes } from '../../modules/integrations/http/http.node-types';
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
 * Part 18, FR-18.7 (as amended by Part 24): provider endpoints are server configuration. The
 * only node that lets a workflow author choose a destination is `http.request`, and it must
 * send through the egress guard (src/infrastructure/egress). Any other URL-like setting must
 * first implement that policy and then be added to ALLOWED deliberately.
 */
const ALLOWED: Record<string, string[]> = { 'http.request': ['url'] };
const policy = {
  allowPlainHttp: false,
  allowPrivateNetworks: false,
  deniedPorts: [],
  deniedHosts: [],
};

describe('no user-configurable outbound URLs (SSRF)', () => {
  const nodeTypes = [
    ...BUILT_IN_NODE_TYPES,
    ...GITHUB_NODE_TYPES,
    ...SLACK_NODE_TYPES,
    ...MICROSOFT_NODE_TYPES,
    ...aiNodeTypes(true),
    ...httpNodeTypes(policy, true),
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
    expect(urlish).toEqual(ALLOWED[t.type] ?? []);
  });

  it('http.request sends only through the egress guard, never a raw HTTP client', () => {
    const source = readFileSync(
      join(__dirname, '../../modules/integrations/http/http.node-types.ts'),
      'utf8',
    );
    expect(source).toMatch(/egress\.send\(/);
    expect(source).not.toMatch(
      /from 'node:(https?|net|tls)'|from '(axios|undici|got|node-fetch)'|\bfetch\(/,
    );
  });
});
