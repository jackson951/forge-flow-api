import { ErrorCategory, IntegrationProviderKey } from '@prisma/client';
import { z, ZodTypeAny } from 'zod';
import { NodeTypeDefinition } from '../../../engine/catalog/node-type-catalog';
import { PermanentError } from '../../../engine/errors';
import { NodeHandler, NodeExecutionContext } from '../../../engine/execution/node-handler';
import { JiraClient, JiraSite, normalizeIssue, textToAdf } from './jira-client';
import { JIRA_TRIGGER_EVENTS } from './jira-webhook.provider';

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;
const ISSUE_KEY = /^([A-Z][A-Z0-9_]{1,9}-\d{1,9}|\d{1,12})$/;
const CUSTOM_FIELD = /^customfield_\d{1,10}$/;
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const FIELD_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const connection = {
  connectionId: z.string().uuid(),
  /** Jira site (cloud id) from the connection's sites. */
  siteId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'pick a Jira site of the connection'),
};
const projectKeys = z
  .array(z.string().regex(PROJECT_KEY, 'a Jira project key such as ENG'))
  .min(1)
  .max(20)
  .refine((k) => new Set(k).size === k.length, 'project keys must not repeat');
const issueTypes = z.array(z.string().min(1).max(60)).max(20).optional();
const statusName = z.string().min(1).max(60).optional();
/** Templates allowed; validated again after rendering. */
const issueKey = z.string().min(1).max(200);
const label = z.string().regex(/^[^\s]{1,255}$/, 'labels cannot contain spaces');
const customFields = z
  .record(
    z.string().regex(CUSTOM_FIELD, 'use field ids such as customfield_10010'),
    z.union([z.string().max(2_000), z.number(), z.boolean()]),
  )
  .refine((f) => Object.keys(f).length <= 20, 'at most 20 custom fields')
  .optional();

// ── Triggers ─────────────────────────────────────────────────────────────────

const triggerSchema = (transitioned: boolean) =>
  z
    .object({
      ...connection,
      projectKeys,
      issueTypes,
      ...(transitioned && { fromStatus: statusName, toStatus: statusName }),
    })
    .strict();

function jiraTrigger(type: string, displayName: string, transitioned = false): NodeTypeDefinition {
  return {
    type,
    kind: 'TRIGGER',
    displayName,
    connectionProvider: IntegrationProviderKey.JIRA,
    configSchema: triggerSchema(transitioned),
    route: (config) => ({
      provider: IntegrationProviderKey.JIRA,
      eventType: type,
      resourceKey: String(config.siteId),
      connectionId: String(config.connectionId),
      filter: {
        projectKeys: config.projectKeys as string[],
        ...(config.issueTypes ? { issueTypes: config.issueTypes as string[] } : {}),
        ...(config.fromStatus ? { fromStatus: config.fromStatus as string } : {}),
        ...(config.toStatus ? { toStatus: config.toStatus as string } : {}),
      },
    }),
  };
}

// ── Actions ──────────────────────────────────────────────────────────────────

const createIssueSchema = z
  .object({
    ...connection,
    projectKey: z.string().min(1).max(200),
    issueType: z.string().min(1).max(60),
    summary: z.string().min(1).max(255),
    description: z.string().max(32_000).optional(),
    priority: z.string().min(1).max(60).optional(),
    labels: z.array(label).max(20).optional(),
    assigneeAccountId: z.string().max(200).optional(),
    customFields,
  })
  .strict();

const updateIssueSchema = z
  .object({
    ...connection,
    issueKey,
    summary: z.string().min(1).max(255).optional(),
    description: z.string().max(32_000).optional(),
    priority: z.string().min(1).max(60).optional(),
    labels: z.array(label).max(20).optional(),
    customFields,
  })
  .strict()
  .refine(
    (c) =>
      c.summary !== undefined ||
      c.description !== undefined ||
      c.priority !== undefined ||
      c.labels !== undefined ||
      c.customFields !== undefined,
    'set at least one field to update',
  );

const getIssueSchema = z
  .object({
    ...connection,
    issueKey,
    fields: z.array(z.string().regex(FIELD_NAME)).max(30).optional(),
  })
  .strict();

const addCommentSchema = z
  .object({ ...connection, issueKey, text: z.string().min(1).max(32_000) })
  .strict();

const transitionSchema = z
  .object({
    ...connection,
    issueKey,
    /** Target status name (resolved through the issue's available transitions), or a transition id. */
    toStatus: z.string().min(1).max(60).optional(),
    transitionId: z
      .string()
      .regex(/^\d{1,10}$/)
      .optional(),
  })
  .strict()
  .refine(
    (c) => Boolean(c.toStatus) !== Boolean(c.transitionId),
    'set exactly one of toStatus or transitionId',
  );

const assignSchema = z
  .object({
    ...connection,
    issueKey,
    /** An Atlassian account id, or "unassigned". */
    assigneeAccountId: z.string().min(1).max(200),
  })
  .strict();

const searchSchema = z
  .object({
    ...connection,
    /** Passed to Jira only; FlowForge never interprets it. */
    jql: z.string().min(1).max(2_000),
    maxResults: z.number().int().min(1).max(100).default(25),
    fields: z.array(z.string().regex(FIELD_NAME)).max(30).optional(),
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
  connectionProvider: IntegrationProviderKey.JIRA,
  configSchema,
});

export const JIRA_NODE_TYPES: NodeTypeDefinition[] = [
  jiraTrigger(JIRA_TRIGGER_EVENTS.created, 'Jira issue created'),
  jiraTrigger(JIRA_TRIGGER_EVENTS.updated, 'Jira issue updated'),
  jiraTrigger(JIRA_TRIGGER_EVENTS.transitioned, 'Jira issue transitioned', true),
  action('jira.createIssue', 'Jira: create issue', createIssueSchema),
  action('jira.getIssue', 'Jira: get issue', getIssueSchema),
  action('jira.updateIssue', 'Jira: update issue', updateIssueSchema),
  action('jira.addComment', 'Jira: add comment', addCommentSchema),
  action('jira.transitionIssue', 'Jira: transition issue', transitionSchema),
  action('jira.assignIssue', 'Jira: assign issue', assignSchema),
  action('jira.searchIssues', 'Jira: search issues', searchSchema),
];

// ── Handlers ─────────────────────────────────────────────────────────────────

/** What Jira handlers may do with connections (worker side, workspace-scoped). */
export interface JiraAccess {
  withToken<T>(
    workspaceId: string,
    connectionId: string,
    call: (token: string) => Promise<T>,
  ): Promise<T>;
  site(workspaceId: string, connectionId: string, cloudId: string): Promise<JiraSite>;
}

const DEFAULT_FIELDS = [
  'summary',
  'description',
  'status',
  'issuetype',
  'priority',
  'project',
  'assignee',
  'reporter',
  'labels',
  'created',
  'updated',
];

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

/** A rendered issue key or id; anything else never reaches the URL. */
function checkedIssueKey(value: string): string {
  const key = value.trim();
  if (!ISSUE_KEY.test(key)) {
    throw new PermanentError(
      ErrorCategory.VALIDATION,
      'The issue key must look like ENG-123 (or a numeric id)',
    );
  }
  return key;
}

function issueFields(c: {
  summary?: string;
  description?: string;
  priority?: string;
  labels?: string[];
  customFields?: Record<string, string | number | boolean>;
}): Record<string, unknown> {
  return {
    ...(c.summary !== undefined && { summary: c.summary.slice(0, 255) }),
    ...(c.description !== undefined && { description: textToAdf(c.description) }),
    ...(c.priority !== undefined && { priority: { name: c.priority } }),
    ...(c.labels !== undefined && { labels: c.labels }),
    ...(c.customFields ?? {}),
  };
}

/**
 * Jira actions (worker). Reads (get, search) are idempotent and retried on transient errors;
 * writes (create, update, comment, transition, assign) are non-idempotent: Jira offers no
 * idempotency key, so an uncertain outcome is never retried automatically (Part 15).
 */
export function createJiraHandlers(client: JiraClient, access: JiraAccess): NodeHandler[] {
  const run = async <T>(
    ctx: NodeExecutionContext,
    connectionId: string,
    siteId: string,
    call: (token: string, site: JiraSite) => Promise<T>,
  ): Promise<T> => {
    const site = await access.site(ctx.workspaceId, connectionId, siteId);
    return access.withToken(ctx.workspaceId, connectionId, (token) => call(token, site));
  };
  const fetchIssue = (token: string, site: JiraSite, key: string, fields = DEFAULT_FIELDS) =>
    client
      .jira<unknown>(
        token,
        site.cloudId,
        'GET',
        `/issue/${encodeURIComponent(key)}?fields=${fields.map(encodeURIComponent).join(',')}`,
      )
      .then((raw) => normalizeIssue(raw, site.url));

  const triggers: NodeHandler[] = Object.values(JIRA_TRIGGER_EVENTS).map((type) => ({
    type,
    kind: 'TRIGGER',
    sideEffect: 'none',
    execute: async ({ triggerInput }) => ({ output: triggerInput ?? {} }),
  }));

  const handlers: NodeHandler[] = [
    {
      type: 'jira.createIssue',
      kind: 'ACTION',
      sideEffect: 'non-idempotent',
      async execute(ctx) {
        const c = parse<z.infer<typeof createIssueSchema>>(
          createIssueSchema,
          ctx.config,
          'Jira create issue',
        );
        if (!PROJECT_KEY.test(c.projectKey.trim())) {
          throw new PermanentError(ErrorCategory.VALIDATION, 'The project key must look like ENG');
        }
        const assignee = c.assigneeAccountId?.trim();
        if (assignee && !ACCOUNT_ID.test(assignee)) {
          throw new PermanentError(
            ErrorCategory.VALIDATION,
            'The assignee must be an Atlassian account id',
          );
        }
        return run(ctx, c.connectionId, c.siteId, async (token, site) => {
          const created = await client.jira<{ id: string; key: string }>(
            token,
            site.cloudId,
            'POST',
            '/issue',
            {
              fields: {
                project: { key: c.projectKey.trim() },
                issuetype: /^\d+$/.test(c.issueType) ? { id: c.issueType } : { name: c.issueType },
                ...issueFields(c),
                ...(assignee && { assignee: { accountId: assignee } }),
              },
            },
            { write: true },
          );
          ctx.logger.info('Jira issue created', { issueKey: created.key, cloudId: site.cloudId });
          // The create succeeded; reading it back is best effort.
          const issue = await fetchIssue(token, site, created.key).catch(() => ({
            id: created.id,
            key: created.key,
            url: site.url ? `${site.url.replace(/\/+$/, '')}/browse/${created.key}` : null,
          }));
          return { output: issue, externalRef: created.key };
        });
      },
    },
    {
      type: 'jira.getIssue',
      kind: 'ACTION',
      sideEffect: 'idempotent',
      async execute(ctx) {
        const c = parse<z.infer<typeof getIssueSchema>>(
          getIssueSchema,
          ctx.config,
          'Jira get issue',
        );
        const key = checkedIssueKey(c.issueKey);
        return run(ctx, c.connectionId, c.siteId, async (token, site) => ({
          output: await fetchIssue(
            token,
            site,
            key,
            c.fields?.length ? [...new Set([...DEFAULT_FIELDS, ...c.fields])] : DEFAULT_FIELDS,
          ),
        }));
      },
    },
    {
      type: 'jira.updateIssue',
      kind: 'ACTION',
      sideEffect: 'non-idempotent',
      async execute(ctx) {
        const c = parse<z.infer<typeof updateIssueSchema>>(
          updateIssueSchema,
          ctx.config,
          'Jira update issue',
        );
        const key = checkedIssueKey(c.issueKey);
        return run(ctx, c.connectionId, c.siteId, async (token, site) => {
          await client.jira(
            token,
            site.cloudId,
            'PUT',
            `/issue/${encodeURIComponent(key)}`,
            { fields: issueFields(c) },
            { write: true },
          );
          ctx.logger.info('Jira issue updated', { issueKey: key, cloudId: site.cloudId });
          const issue = await fetchIssue(token, site, key).catch(() => ({ key }));
          return { output: issue, externalRef: key };
        });
      },
    },
    {
      type: 'jira.addComment',
      kind: 'ACTION',
      sideEffect: 'non-idempotent',
      async execute(ctx) {
        const c = parse<z.infer<typeof addCommentSchema>>(
          addCommentSchema,
          ctx.config,
          'Jira add comment',
        );
        const key = checkedIssueKey(c.issueKey);
        return run(ctx, c.connectionId, c.siteId, async (token, site) => {
          const comment = await client.jira<{ id: string; created?: string }>(
            token,
            site.cloudId,
            'POST',
            `/issue/${encodeURIComponent(key)}/comment`,
            { body: textToAdf(c.text.slice(0, 32_000)) },
            { write: true },
          );
          ctx.logger.info('Jira comment added', { issueKey: key, cloudId: site.cloudId });
          return {
            output: { issueKey: key, commentId: comment.id, created: comment.created ?? null },
            externalRef: comment.id,
          };
        });
      },
    },
    {
      type: 'jira.transitionIssue',
      kind: 'ACTION',
      sideEffect: 'non-idempotent',
      async execute(ctx) {
        const c = parse<z.infer<typeof transitionSchema>>(
          transitionSchema,
          ctx.config,
          'Jira transition issue',
        );
        const key = checkedIssueKey(c.issueKey);
        return run(ctx, c.connectionId, c.siteId, async (token, site) => {
          const { transitions = [] } = await client.jira<{
            transitions?: { id: string; name?: string; to?: { name?: string } }[];
          }>(token, site.cloudId, 'GET', `/issue/${encodeURIComponent(key)}/transitions`);
          const wanted = c.toStatus?.trim().toLowerCase();
          const transition = c.transitionId
            ? transitions.find((t) => t.id === c.transitionId)
            : (transitions.find((t) => t.to?.name?.toLowerCase() === wanted) ??
              transitions.find((t) => t.name?.toLowerCase() === wanted));
          if (!transition) {
            const available = transitions
              .map((t) => t.to?.name ?? t.name)
              .filter(Boolean)
              .join(', ');
            throw new PermanentError(
              ErrorCategory.VALIDATION,
              `No transition to "${c.toStatus ?? c.transitionId}" is available for ${key}${available ? ` (available: ${available.slice(0, 200)})` : ''}`,
            );
          }
          await client.jira(
            token,
            site.cloudId,
            'POST',
            `/issue/${encodeURIComponent(key)}/transitions`,
            { transition: { id: transition.id } },
            { write: true },
          );
          ctx.logger.info('Jira issue transitioned', {
            issueKey: key,
            transitionId: transition.id,
          });
          return {
            output: {
              issueKey: key,
              transitionId: transition.id,
              toStatus: transition.to?.name ?? transition.name ?? null,
            },
            externalRef: `${key}:${transition.id}`,
          };
        });
      },
    },
    {
      type: 'jira.assignIssue',
      kind: 'ACTION',
      sideEffect: 'non-idempotent',
      async execute(ctx) {
        const c = parse<z.infer<typeof assignSchema>>(
          assignSchema,
          ctx.config,
          'Jira assign issue',
        );
        const key = checkedIssueKey(c.issueKey);
        const assignee = c.assigneeAccountId.trim();
        const unassign = assignee.toLowerCase() === 'unassigned';
        if (!unassign && !ACCOUNT_ID.test(assignee)) {
          throw new PermanentError(
            ErrorCategory.VALIDATION,
            'The assignee must be an Atlassian account id or "unassigned"',
          );
        }
        return run(ctx, c.connectionId, c.siteId, async (token, site) => {
          await client.jira(
            token,
            site.cloudId,
            'PUT',
            `/issue/${encodeURIComponent(key)}/assignee`,
            { accountId: unassign ? null : assignee },
            { write: true },
          );
          ctx.logger.info('Jira issue assigned', { issueKey: key });
          return { output: { issueKey: key, assigneeAccountId: unassign ? null : assignee } };
        });
      },
    },
    {
      type: 'jira.searchIssues',
      kind: 'ACTION',
      sideEffect: 'idempotent',
      async execute(ctx) {
        const c = parse<z.infer<typeof searchSchema>>(
          searchSchema,
          ctx.config,
          'Jira search issues',
        );
        return run(ctx, c.connectionId, c.siteId, async (token, site) => {
          const body = await client.jira<{
            issues?: unknown[];
            nextPageToken?: string;
            isLast?: boolean;
          }>(token, site.cloudId, 'POST', '/search/jql', {
            jql: c.jql,
            maxResults: c.maxResults,
            fields: c.fields?.length
              ? [...new Set([...DEFAULT_FIELDS, ...c.fields])]
              : DEFAULT_FIELDS,
          });
          const issues = (body.issues ?? []).slice(0, c.maxResults).map((raw) => {
            const issue = normalizeIssue(raw, site.url);
            // Search results feed loops and AI steps: keep descriptions short.
            return { ...issue, description: issue.description?.slice(0, 1_000) ?? null };
          });
          return {
            output: {
              issues,
              count: issues.length,
              hasMore: body.isLast === false || Boolean(body.nextPageToken),
            },
          };
        });
      },
    },
  ];
  return [...triggers, ...handlers];
}
