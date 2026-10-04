import { ErrorCategory, IntegrationProviderKey } from '@prisma/client';
import { z, ZodTypeAny } from 'zod';
import { NodeTypeDefinition } from '../../../engine/catalog/node-type-catalog';
import { PermanentError } from '../../../engine/errors';
import { NodeExecutionContext, NodeHandler } from '../../../engine/execution/node-handler';
import { GmailClient } from './gmail-client';
import {
  bareAddress,
  buildRawEmail,
  EmailValidationError,
  emailOutput,
  normalizeMessage,
  parseAddresses,
  replySubject,
} from './gmail-mime';

export const GMAIL_TRIGGERS = {
  received: 'gmail.email.received',
  labelReceived: 'gmail.email.labelReceived',
} as const;

const LABEL_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Trigger filters implemented today; the object is strict so later filters extend it safely. */
const filterSchema = z
  .object({
    from: z.string().min(1).max(200).optional(),
    subjectContains: z.string().min(1).max(200).optional(),
  })
  .strict()
  .optional();

export interface GmailTriggerFilter {
  labelId?: string;
  includeSentByMe?: boolean;
  from?: string;
  subjectContains?: string;
}

const triggerRoute = (type: string) => (config: Record<string, unknown>) => ({
  provider: IntegrationProviderKey.GMAIL,
  eventType: type,
  resourceKey: String(config.connectionId),
  connectionId: String(config.connectionId),
  filter: {
    ...(config.labelId ? { labelId: config.labelId as string } : {}),
    includeSentByMe: Boolean(config.includeSentByMe),
    ...((config.filter as object | undefined) ?? {}),
  },
});

const sendSchema = z
  .object({
    connectionId: z.string().uuid(),
    /** Comma-separated; templates allowed (validated after rendering). */
    to: z.string().min(1).max(4_000),
    cc: z.string().max(4_000).optional(),
    bcc: z.string().max(4_000).optional(),
    replyTo: z.string().max(1_000).optional(),
    subject: z.string().min(1).max(998),
    text: z.string().min(1).max(100_000),
    html: z.string().max(200_000).optional(),
  })
  .strict();

const replySchema = z
  .object({
    connectionId: z.string().uuid(),
    messageId: z.string().min(1).max(200),
    text: z.string().min(1).max(100_000),
    html: z.string().max(200_000).optional(),
    replyAll: z.boolean().default(false),
  })
  .strict();

const messageSchema = z
  .object({ connectionId: z.string().uuid(), messageId: z.string().min(1).max(200) })
  .strict();
const labelSchema = z
  .object({
    connectionId: z.string().uuid(),
    messageId: z.string().min(1).max(200),
    labelId: z.string().regex(LABEL_ID, 'pick a label from the list'),
  })
  .strict();

const action = (
  type: string,
  displayName: string,
  configSchema: ZodTypeAny,
): NodeTypeDefinition => ({
  type,
  kind: 'ACTION',
  displayName,
  connectionProvider: IntegrationProviderKey.GMAIL,
  configSchema,
});

/** Triggers need the Pub/Sub topic and push verification on this server (FR-26.4/26.5). */
export function gmailNodeTypes(triggersConfigured: boolean): NodeTypeDefinition[] {
  const unavailable = !triggersConfigured && {
    unavailableReason:
      'Gmail triggers need GMAIL_PUBSUB_TOPIC and push verification settings on this server',
  };
  return [
    {
      type: GMAIL_TRIGGERS.received,
      kind: 'TRIGGER',
      displayName: 'Gmail: new email',
      connectionProvider: IntegrationProviderKey.GMAIL,
      configSchema: z
        .object({
          connectionId: z.string().uuid(),
          /** Messages the mailbox sent itself are skipped unless this is on. */
          includeSentByMe: z.boolean().default(false),
          filter: filterSchema,
        })
        .strict(),
      route: triggerRoute(GMAIL_TRIGGERS.received),
      ...unavailable,
    },
    {
      type: GMAIL_TRIGGERS.labelReceived,
      kind: 'TRIGGER',
      displayName: 'Gmail: email gets a label',
      connectionProvider: IntegrationProviderKey.GMAIL,
      configSchema: z
        .object({
          connectionId: z.string().uuid(),
          labelId: z.string().regex(LABEL_ID, 'pick a label from the list'),
          includeSentByMe: z.boolean().default(false),
          filter: filterSchema,
        })
        .strict(),
      route: triggerRoute(GMAIL_TRIGGERS.labelReceived),
      ...unavailable,
    },
    action('gmail.sendEmail', 'Gmail: send email', sendSchema),
    action('gmail.replyToEmail', 'Gmail: reply to email', replySchema),
    action('gmail.getEmail', 'Gmail: get email', messageSchema),
    action('gmail.addLabel', 'Gmail: add label', labelSchema),
    action('gmail.removeLabel', 'Gmail: remove label', labelSchema),
    action('gmail.markAsRead', 'Gmail: mark as read', messageSchema),
    action('gmail.markAsUnread', 'Gmail: mark as unread', messageSchema),
  ];
}

/** What Gmail handlers may do (worker side, workspace-scoped). */
export interface GmailAccess {
  withToken<T>(
    workspaceId: string,
    connectionId: string,
    call: (token: string) => Promise<T>,
  ): Promise<T>;
  mailbox(workspaceId: string, connectionId: string): Promise<string>;
  /** Counts one sent email against the workspace's daily cap; false when the cap is reached. */
  reserveSend(workspaceId: string): Promise<boolean>;
}

function parse<T>(schema: ZodTypeAny, config: unknown, label: string): T {
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PermanentError(
      ErrorCategory.VALIDATION,
      `Invalid ${label} configuration: ${issue.path.join('.') || 'config'} ${issue.message}`,
    );
  }
  return parsed.data as T;
}

function checkedMessageId(value: string): string {
  const id = value.trim();
  if (!MESSAGE_ID.test(id))
    throw new PermanentError(ErrorCategory.VALIDATION, 'The message id is not a Gmail message id');
  return id;
}

/** Invalid addresses / header injection → VALIDATION, never sent. */
function email<T>(build: () => T): T {
  try {
    return build();
  } catch (err) {
    if (err instanceof EmailValidationError)
      throw new PermanentError(ErrorCategory.VALIDATION, err.message);
    throw err;
  }
}

/**
 * Gmail actions (worker). Send and reply are non-idempotent (Gmail has no idempotency key; an
 * uncertain outcome is never retried automatically). Label and read-state changes are
 * idempotent (applying them twice is the same); get is a read. Logs carry message ids only —
 * never addresses, subjects or bodies.
 */
export function createGmailHandlers(
  client: GmailClient,
  access: GmailAccess,
  maxBodyChars: number,
): NodeHandler[] {
  const withToken = <T>(
    ctx: NodeExecutionContext,
    connectionId: string,
    call: (token: string) => Promise<T>,
  ) => access.withToken(ctx.workspaceId, connectionId, call);

  const reserve = async (ctx: NodeExecutionContext) => {
    if (!(await access.reserveSend(ctx.workspaceId))) {
      throw new PermanentError(
        ErrorCategory.VALIDATION,
        'The workspace reached its daily Gmail send limit',
      );
    }
  };

  const modify = (
    type: string,
    label: string,
    change: (c: { labelId?: string }) => { add: string[]; remove: string[] },
    schema: ZodTypeAny,
  ): NodeHandler => ({
    type,
    kind: 'ACTION',
    sideEffect: 'idempotent',
    async execute(ctx) {
      const c = parse<{ connectionId: string; messageId: string; labelId?: string }>(
        schema,
        ctx.config,
        label,
      );
      const id = checkedMessageId(c.messageId);
      const { add, remove } = change(c);
      const result = await withToken(ctx, c.connectionId, (token) =>
        client.modify(token, id, add, remove),
      );
      ctx.logger.info('Gmail message modified', { messageId: id });
      return { output: { messageId: id, labelIds: result.labelIds ?? [] } };
    },
  });

  const triggers: NodeHandler[] = Object.values(GMAIL_TRIGGERS).map((type) => ({
    type,
    kind: 'TRIGGER',
    sideEffect: 'none',
    execute: async ({ triggerInput }) => ({ output: triggerInput ?? {} }),
  }));

  return [
    ...triggers,
    {
      type: 'gmail.sendEmail',
      kind: 'ACTION',
      sideEffect: 'non-idempotent',
      async execute(ctx) {
        const c = parse<z.infer<typeof sendSchema>>(sendSchema, ctx.config, 'Gmail send email');
        const from = await access.mailbox(ctx.workspaceId, c.connectionId);
        const raw = email(() =>
          buildRawEmail({
            from,
            to: parseAddresses(c.to, 'To'),
            cc: parseAddresses(c.cc, 'Cc'),
            bcc: parseAddresses(c.bcc, 'Bcc'),
            replyTo: parseAddresses(c.replyTo, 'Reply-To'),
            subject: c.subject,
            text: c.text,
            html: c.html,
          }),
        );
        await reserve(ctx);
        const sent = await withToken(ctx, c.connectionId, (token) => client.send(token, raw));
        ctx.logger.info('Gmail email sent', { messageId: sent.id });
        return { output: { messageId: sent.id, threadId: sent.threadId }, externalRef: sent.id };
      },
    },
    {
      type: 'gmail.replyToEmail',
      kind: 'ACTION',
      sideEffect: 'non-idempotent',
      async execute(ctx) {
        const c = parse<z.infer<typeof replySchema>>(replySchema, ctx.config, 'Gmail reply');
        const id = checkedMessageId(c.messageId);
        const mailbox = (await access.mailbox(ctx.workspaceId, c.connectionId)).toLowerCase();
        return withToken(ctx, c.connectionId, async (token) => {
          const original = normalizeMessage(
            await client.message(token, id, 'metadata'),
            mailbox,
            0,
          );
          const raw = email(() => {
            const replyTo = parseAddresses(original.replyTo ?? original.from ?? '', 'To');
            const others = c.replyAll
              ? [
                  ...parseAddresses(original.to ?? '', 'To'),
                  ...parseAddresses(original.cc ?? '', 'Cc'),
                ].filter(
                  (a) =>
                    bareAddress(a) !== mailbox &&
                    !replyTo.some((r) => bareAddress(r) === bareAddress(a)),
                )
              : [];
            return buildRawEmail({
              from: mailbox,
              to: replyTo,
              cc: others,
              subject: replySubject(original.subject ?? ''),
              text: c.text,
              html: c.html,
              inReplyTo: original.rfcMessageId ?? undefined,
              references:
                [original.references, original.rfcMessageId].filter(Boolean).join(' ') || undefined,
            });
          });
          await reserve(ctx);
          const sent = await client.send(token, raw, original.threadId ?? undefined);
          ctx.logger.info('Gmail reply sent', { messageId: sent.id, inReplyTo: id });
          return {
            output: { messageId: sent.id, threadId: sent.threadId, inReplyTo: id },
            externalRef: sent.id,
          };
        });
      },
    },
    {
      type: 'gmail.getEmail',
      kind: 'ACTION',
      sideEffect: 'idempotent',
      async execute(ctx) {
        const c = parse<z.infer<typeof messageSchema>>(
          messageSchema,
          ctx.config,
          'Gmail get email',
        );
        const id = checkedMessageId(c.messageId);
        const mailbox = await access.mailbox(ctx.workspaceId, c.connectionId);
        const message = await withToken(ctx, c.connectionId, (token) => client.message(token, id));
        const output = emailOutput(normalizeMessage(message, mailbox, maxBodyChars));
        return { output };
      },
    },
    modify(
      'gmail.addLabel',
      'Gmail add label',
      (c) => ({ add: [c.labelId!], remove: [] }),
      labelSchema,
    ),
    modify(
      'gmail.removeLabel',
      'Gmail remove label',
      (c) => ({ add: [], remove: [c.labelId!] }),
      labelSchema,
    ),
    modify(
      'gmail.markAsRead',
      'Gmail mark as read',
      () => ({ add: [], remove: ['UNREAD'] }),
      messageSchema,
    ),
    modify(
      'gmail.markAsUnread',
      'Gmail mark as unread',
      () => ({ add: ['UNREAD'], remove: [] }),
      messageSchema,
    ),
  ];
}
