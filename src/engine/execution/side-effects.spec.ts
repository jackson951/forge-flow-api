import { BUILT_IN_NODE_TYPES, NodeTypeCatalog } from '../catalog/node-type-catalog';
import { aiNodeTypes, createAiHandlers } from '../../modules/ai/ai.node-types';
import {
  GITHUB_HANDLERS,
  GITHUB_NODE_TYPES,
} from '../../modules/integrations/github/github.node-types';
import {
  createMicrosoftHandlers,
  MICROSOFT_NODE_TYPES,
} from '../../modules/integrations/microsoft/microsoft.node-types';
import {
  createSlackHandlers,
  SLACK_NODE_TYPES,
} from '../../modules/integrations/slack/slack.node-types';
import { createHttpHandlers } from '../../modules/integrations/http/http.node-types';
import { WEBHOOK_HANDLERS } from '../../modules/hooks/hook.node-types';
import { createJiraHandlers } from '../../modules/integrations/jira/jira.node-types';
import { BUILT_IN_HANDLERS } from './built-in-handlers';
import { NodeHandlerRegistry } from './handler-registry';
import { NodeHandler } from './node-handler';

/**
 * AC-15.9: the reviewed side-effect classification of every production handler
 * (docs/backend/15-IDEMPOTENCY-AND-SIDE-EFFECT-SAFETY.md). Adding or reclassifying a
 * handler fails this test until the table here and in the document are updated.
 */
const REVIEWED: Record<string, NodeHandler['sideEffect']> = {
  'manual.trigger': 'none',
  'schedule.trigger': 'none',
  condition: 'none',
  'util.log': 'none',
  'github.issue.created': 'none',
  'slack.sendMessage': 'non-idempotent',
  'microsoft.todo.createTask': 'non-idempotent',
  'ai.summarize': 'idempotent',
  'ai.classify': 'idempotent',
  'ai.extract': 'idempotent',
  'http.request': 'non-idempotent',
  'http.poll': 'none',
  'webhook.received': 'none',
  'jira.issue.created': 'none',
  'jira.issue.updated': 'none',
  'jira.issue.transitioned': 'none',
  'jira.createIssue': 'non-idempotent',
  'jira.getIssue': 'idempotent',
  'jira.updateIssue': 'non-idempotent',
  'jira.addComment': 'non-idempotent',
  'jira.transitionIssue': 'non-idempotent',
  'jira.assignIssue': 'non-idempotent',
  'jira.searchIssues': 'idempotent',
};

const productionHandlers = (): NodeHandler[] => [
  ...BUILT_IN_HANDLERS,
  ...GITHUB_HANDLERS,
  ...createSlackHandlers({} as never, {} as never),
  ...createMicrosoftHandlers({} as never, {} as never),
  ...createAiHandlers(null, { maxInputChars: 1000, maxOutputTokens: 64 }),
  ...createHttpHandlers({} as never, {} as never, {} as never),
  ...WEBHOOK_HANDLERS,
  ...createJiraHandlers({} as never, {} as never),
];

describe('handler side-effect classification (AC-15.9)', () => {
  it('matches the reviewed table for every production handler', () => {
    expect(Object.fromEntries(productionHandlers().map((h) => [h.type, h.sideEffect]))).toEqual(
      REVIEWED,
    );
  });

  it('the worker refuses to start with a handler that declares no valid sideEffect', () => {
    const catalog = new NodeTypeCatalog([
      ...BUILT_IN_NODE_TYPES,
      ...GITHUB_NODE_TYPES,
      ...SLACK_NODE_TYPES,
      ...MICROSOFT_NODE_TYPES,
      ...aiNodeTypes(true),
    ]);
    expect(new NodeHandlerRegistry(productionHandlers()).verifyAgainst(catalog)).toEqual([]);

    const broken = productionHandlers().map((h) =>
      h.type === 'slack.sendMessage' ? { ...h, sideEffect: undefined as never } : h,
    );
    expect(new NodeHandlerRegistry(broken).verifyAgainst(catalog)).toEqual([
      'Handler for "slack.sendMessage" does not declare a valid sideEffect',
    ]);
  });
});
