import { IntegrationProviderKey } from '@prisma/client';
import { z } from 'zod';
import { NodeTypeDefinition } from '../../../engine/catalog/node-type-catalog';
import { NodeHandler } from '../../../engine/execution/node-handler';

const REPOSITORY = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * "GitHub issue created": runs when an issue is opened in the repository, through the
 * workspace's GitHub connection. `trigger.*` is the normalised issue event
 * (see GitHubWebhookProvider.normalize).
 */
export const githubIssueCreated: NodeTypeDefinition = {
  type: 'github.issue.created',
  kind: 'TRIGGER',
  displayName: 'GitHub issue created',
  connectionProvider: IntegrationProviderKey.GITHUB,
  configSchema: z
    .object({
      connectionId: z.string().uuid(),
      repository: z.string().regex(REPOSITORY, 'must be "owner/name"'),
    })
    .strict(),
  route: (config) => ({
    provider: IntegrationProviderKey.GITHUB,
    eventType: 'issues.opened',
    resourceKey: String(config.repository).toLowerCase(),
    connectionId: String(config.connectionId),
  }),
};

export const GITHUB_NODE_TYPES: NodeTypeDefinition[] = [githubIssueCreated];

export const GITHUB_HANDLERS: NodeHandler[] = [
  {
    type: 'github.issue.created',
    kind: 'TRIGGER',
    sideEffect: 'none',
    execute: async ({ triggerInput }) => ({ output: triggerInput ?? {} }),
  },
];
