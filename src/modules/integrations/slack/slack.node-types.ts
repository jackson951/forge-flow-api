import { ErrorCategory, IntegrationProviderKey } from '@prisma/client';
import { z } from 'zod';
import { NodeTypeDefinition } from '../../../engine/catalog/node-type-catalog';
import { ExecutionError, PermanentError } from '../../../engine/errors';
import { NodeHandler } from '../../../engine/execution/node-handler';
import type { ConnectionAccess } from '../../../execution/worker-connections';
import { SlackClient } from './slack-client';

export const SLACK_MAX_TEXT = 3_000;
const TRUNCATION_SUFFIX = '…';

export const sendMessageConfigSchema = z
  .object({
    connectionId: z.string().uuid(),
    channelId: z
      .string()
      .regex(/^[CG][A-Z0-9]{2,30}$/, 'must be a Slack channel ID such as C0123456789'),
    /** Template (Part 11); rendered text longer than 3 000 characters is truncated. */
    text: z.string().min(1).max(SLACK_MAX_TEXT),
    /** Off by default so data such as issue titles cannot ping a whole channel. */
    allowBroadcastMentions: z.boolean().default(false),
  })
  .strict();

type SendMessageConfig = z.infer<typeof sendMessageConfigSchema>;

/** `<!channel>`, `<!here>`, `<!everyone>` (optionally with a label) and user-group mentions. */
const BROADCAST_MENTION = /<!(?:channel|here|everyone)(?:\|[^>]*)?>|<!subteam\^[^>]*>/gi;

/** Neutralises broadcast mentions: shown as text, no notification. */
export function escapeBroadcastMentions(text: string): string {
  return text.replace(BROADCAST_MENTION, (m) => m.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
}

export const slackSendMessage: NodeTypeDefinition = {
  type: 'slack.sendMessage',
  kind: 'ACTION',
  displayName: 'Slack: send message',
  connectionProvider: IntegrationProviderKey.SLACK,
  configSchema: sendMessageConfigSchema,
};

export const SLACK_NODE_TYPES: NodeTypeDefinition[] = [slackSendMessage];

/**
 * `slack.sendMessage`. Not idempotent: Slack has no idempotency key for chat.postMessage, so
 * a step found RUNNING after a crash fails as UNCERTAIN_OUTCOME instead of posting twice
 * (engine rule), and the message `ts` is kept as the step's externalRef.
 */
export function createSlackHandlers(
  slack: SlackClient,
  connections: ConnectionAccess,
): NodeHandler[] {
  const sendMessage: NodeHandler = {
    type: 'slack.sendMessage',
    kind: 'ACTION',
    sideEffect: 'non-idempotent',
    async execute({ workspaceId, config, logger }) {
      const rendered = typeof config.text === 'string' ? config.text : '';
      const truncated = rendered.length > SLACK_MAX_TEXT;
      const parsed = sendMessageConfigSchema.safeParse({
        ...config,
        text: truncated
          ? rendered.slice(0, SLACK_MAX_TEXT - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX
          : rendered,
      });
      if (!parsed.success) {
        throw new PermanentError(ErrorCategory.VALIDATION, 'Invalid Slack message configuration');
      }
      const { connectionId, channelId, allowBroadcastMentions }: SendMessageConfig = parsed.data;
      const text = allowBroadcastMentions
        ? parsed.data.text
        : escapeBroadcastMentions(parsed.data.text);

      const token = await connections.accessToken(
        workspaceId,
        connectionId,
        IntegrationProviderKey.SLACK,
      );
      let ts: string;
      try {
        ts = await slack.postMessage(token, channelId, text);
      } catch (err) {
        if (err instanceof ExecutionError && err.category === ErrorCategory.PROVIDER_AUTH) {
          await connections.markNeedsAttention(workspaceId, connectionId);
        }
        throw err;
      }
      logger.info('Slack message posted', { channelId, textLength: text.length, truncated });
      return {
        output: { channelId, ts, ...(truncated && { truncated: true }) },
        externalRef: ts,
      };
    },
  };
  return [sendMessage];
}
