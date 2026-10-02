import { ErrorCategory, IntegrationProviderKey } from '@prisma/client';
import { z } from 'zod';
import { NodeTypeDefinition } from '../../../engine/catalog/node-type-catalog';
import { PermanentError } from '../../../engine/errors';
import { NodeHandler } from '../../../engine/execution/node-handler';
import { MicrosoftClient } from './microsoft-client';
import { MicrosoftTokenManager } from './microsoft-token-manager';

export const TODO_LIMITS = { title: 255, body: 4_000 };
const ELLIPSIS = '…';

/** Graph To Do list ids are opaque base64-like strings. */
const LIST_ID = /^[A-Za-z0-9=_+/-]{1,512}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;

export const createTaskConfigSchema = z
  .object({
    connectionId: z.string().uuid(),
    listId: z.string().regex(LIST_ID, 'must be a Microsoft To Do list id'),
    /** Templates (Part 11); rendered text above the limits is truncated. */
    title: z.string().min(1).max(TODO_LIMITS.title),
    body: z.string().max(TODO_LIMITS.body).optional(),
    /** Template or literal rendering to YYYY-MM-DD (an ISO date-time is cut to its date). */
    dueDate: z.string().max(100).optional(),
  })
  .strict();

export const microsoftCreateTask: NodeTypeDefinition = {
  type: 'microsoft.todo.createTask',
  kind: 'ACTION',
  displayName: 'Microsoft To Do: create task',
  connectionProvider: IntegrationProviderKey.MICROSOFT,
  configSchema: createTaskConfigSchema,
};

export const MICROSOFT_NODE_TYPES: NodeTypeDefinition[] = [microsoftCreateTask];

const truncate = (text: string, max: number) =>
  text.length > max ? text.slice(0, max - ELLIPSIS.length) + ELLIPSIS : text;

/** Rendered due date → YYYY-MM-DD, undefined when empty; invalid dates fail the step. */
export function normaliseDueDate(value: unknown): string | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const match = DATE.exec(String(value).trim());
  const date = match && new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  if (!match || !date || date.getUTCMonth() !== +match[2] - 1 || date.getUTCDate() !== +match[3]) {
    throw new PermanentError(
      ErrorCategory.VALIDATION,
      'dueDate must be a date in YYYY-MM-DD format',
    );
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * `microsoft.todo.createTask`. Not idempotent (no idempotency key in Graph To Do): a step found
 * RUNNING after a crash fails as UNCERTAIN_OUTCOME (engine rule), and the task id is kept as
 * the step's externalRef. Acts as the user who connected Microsoft.
 */
export function createMicrosoftHandlers(
  client: MicrosoftClient,
  tokens: MicrosoftTokenManager,
): NodeHandler[] {
  const createTask: NodeHandler = {
    type: 'microsoft.todo.createTask',
    kind: 'ACTION',
    sideEffect: 'non-idempotent',
    async execute({ workspaceId, config, logger }) {
      const title = truncate(String(config.title ?? '').trim(), TODO_LIMITS.title);
      const body =
        typeof config.body === 'string' && config.body.trim()
          ? truncate(config.body, TODO_LIMITS.body)
          : undefined;
      if (!title) {
        throw new PermanentError(ErrorCategory.VALIDATION, 'Task title is empty after rendering');
      }
      const dueDate = normaliseDueDate(config.dueDate);
      const parsed = createTaskConfigSchema.safeParse({
        connectionId: config.connectionId,
        listId: config.listId,
        title,
        ...(body && { body }),
      });
      if (!parsed.success) {
        throw new PermanentError(ErrorCategory.VALIDATION, 'Invalid Microsoft To Do configuration');
      }
      const { connectionId, listId } = parsed.data;

      const task = await tokens.withToken(workspaceId, connectionId, (accessToken) =>
        client.createTask(accessToken, listId, { title, body, dueDate }),
      );
      logger.info('Microsoft To Do task created', {
        listId,
        titleLength: title.length,
        requestId: task.requestId,
      });
      return {
        output: {
          taskId: task.id,
          listId,
          ...(String(config.title ?? '').trim().length > TODO_LIMITS.title && {
            titleTruncated: true,
          }),
          ...(typeof config.body === 'string' &&
            config.body.length > TODO_LIMITS.body && { bodyTruncated: true }),
        },
        externalRef: task.id,
      };
    },
  };
  return [createTask];
}
