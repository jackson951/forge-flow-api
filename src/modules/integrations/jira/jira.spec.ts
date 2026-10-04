import { ErrorCategory } from '@prisma/client';
import { AppConfigService } from '../../../config/app-config.service';
import { projectsJql } from '../../../execution/jira-subscriptions.service';
import {
  adfToText,
  JiraConsentError,
  JiraUnauthorizedError,
  mapJiraError,
  mapTokenError,
  normalizeIssue,
  textToAdf,
} from './jira-client';
import {
  signJwt,
  verifyBearerJwt,
  verifyWebhookParams,
  webhookUrl,
  webhookUrlParams,
} from './jira-webhook-auth';
import { JiraWebhookProvider } from './jira-webhook.provider';
import { JIRA_NODE_TYPES } from './jira.node-types';

// Assembled at runtime: not a real secret format.
const SECRET = ['jira', 'app', 'secret', 'for', 'tests'].join('-');
const CONNECTION = '6f2b8c1e-1d1a-4c3b-9a7e-2b1c3d4e5f60';
const CLOUD = 'site-cloud-1';
const headers = (h: Record<string, string> = {}) => new Headers(h);

describe('Jira (Part 25)', () => {
  describe('ADF', () => {
    it('turns plain text into paragraphs with line breaks, and back', () => {
      const adf = textToAdf('First line\nsecond line\n\nNew paragraph');
      expect(adf).toEqual({
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'First line' },
              { type: 'hardBreak' },
              { type: 'text', text: 'second line' },
            ],
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'New paragraph' }] },
        ],
      });
      expect(adfToText(adf)).toBe('First line\nsecond line\nNew paragraph');
      expect(adfToText('plain')).toBe('plain');
      expect(adfToText(null)).toBeNull();
      expect(adfToText(textToAdf('x'.repeat(10_000)), 100)).toHaveLength(100);
    });
  });

  it('normalises an issue', () => {
    expect(
      normalizeIssue(
        {
          id: '10001',
          key: 'ENG-7',
          fields: {
            summary: 'Broken build',
            description: textToAdf('Steps'),
            status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
            issuetype: { name: 'Bug' },
            priority: { name: 'High' },
            project: { key: 'ENG', name: 'Engineering' },
            assignee: { accountId: 'acc-1', displayName: 'Ada' },
            reporter: null,
            labels: ['ci', 3],
            created: '2026-10-01T10:00:00.000+0000',
          },
        },
        'https://acme.atlassian.net/',
      ),
    ).toEqual({
      id: '10001',
      key: 'ENG-7',
      summary: 'Broken build',
      description: 'Steps',
      status: 'In Progress',
      statusCategory: 'indeterminate',
      type: 'Bug',
      priority: 'High',
      project: { key: 'ENG', name: 'Engineering' },
      assignee: { accountId: 'acc-1', displayName: 'Ada' },
      reporter: null,
      labels: ['ci'],
      url: 'https://acme.atlassian.net/browse/ENG-7',
      created: '2026-10-01T10:00:00.000+0000',
      updated: null,
    });
  });

  describe('errors (Part 25 error table)', () => {
    it('maps Jira statuses', () => {
      expect(mapJiraError(401, headers(), {}, false)).toBeInstanceOf(JiraUnauthorizedError);
      expect(mapJiraError(403, headers(), {}, false)).toMatchObject({
        category: ErrorCategory.AUTHORIZATION,
        retryable: false,
      });
      expect(mapJiraError(404, headers(), {}, false)).toMatchObject({
        category: ErrorCategory.PERMANENT_PROVIDER_ERROR,
      });
      expect(mapJiraError(409, headers(), {}, true)).toMatchObject({
        category: ErrorCategory.PERMANENT_PROVIDER_ERROR,
      });
      expect(
        mapJiraError(
          400,
          headers(),
          { errorMessages: ['Bad JQL'], errors: { summary: 'Summary is required', x: 5 } },
          true,
        ),
      ).toMatchObject({
        category: ErrorCategory.VALIDATION,
        message: 'Jira rejected the request: Bad JQL; summary: Summary is required',
      });
      expect(mapJiraError(429, headers({ 'retry-after': '12' }), {}, false)).toMatchObject({
        category: ErrorCategory.PROVIDER_RATE_LIMIT,
        retryable: true,
        retryAfterMs: 12_000,
      });
      expect(mapJiraError(503, headers(), {}, true)).toMatchObject({ retryable: true });
      expect(mapJiraError(500, headers(), {}, false)).toMatchObject({
        category: ErrorCategory.TRANSIENT_INFRASTRUCTURE,
        retryable: true,
      });
      expect(mapJiraError(502, headers(), {}, true)).toMatchObject({
        category: ErrorCategory.UNCERTAIN_OUTCOME,
        retryable: false,
      });
    });

    it('maps token endpoint errors: revoked grants vs our app credentials', () => {
      expect(mapTokenError(403, headers(), { error: 'invalid_grant' })).toBeInstanceOf(
        JiraConsentError,
      );
      expect(mapTokenError(403, headers(), {})).toBeInstanceOf(JiraConsentError);
      expect(mapTokenError(401, headers(), { error: 'invalid_client' }).message).toMatch(
        /app credentials/,
      );
      expect(mapTokenError(429, headers(), {})).toMatchObject({ retryable: true });
    });
  });

  describe('webhook authenticity (FR-25.5)', () => {
    it('signs and verifies the registered URL parameters', () => {
      const url = new URL(webhookUrl('https://api.example.com/api/v1', SECRET, CONNECTION, CLOUD));
      expect(url.pathname).toBe('/api/v1/webhooks/jira');
      const query = Object.fromEntries(url.searchParams);
      expect(verifyWebhookParams(SECRET, query)).toEqual({
        connectionId: CONNECTION,
        cloudId: CLOUD,
      });
      expect(verifyWebhookParams('other-secret', query)).toBeNull();
      expect(verifyWebhookParams(SECRET, { ...query, s: 'site-cloud-2' })).toBeNull(); // re-routed
      expect(
        verifyWebhookParams(SECRET, { ...query, c: '00000000-0000-4000-8000-000000000000' }),
      ).toBeNull();
      expect(verifyWebhookParams(SECRET, {})).toBeNull();
    });

    it('verifies the HS256 bearer token and rejects other algorithms or expired tokens', () => {
      const now = 1_800_000_000_000;
      const valid = signJwt(SECRET, { exp: now / 1_000 + 300 });
      expect(verifyBearerJwt(SECRET, `Bearer ${valid}`, now)).toEqual({ ok: true });
      expect(verifyBearerJwt('wrong', `Bearer ${valid}`, now)).toMatchObject({
        ok: false,
        reason: 'token signature mismatch',
      });
      expect(verifyBearerJwt(SECRET, undefined, now)).toMatchObject({
        ok: false,
        reason: 'bearer token missing',
      });
      expect(
        verifyBearerJwt(SECRET, `Bearer ${signJwt(SECRET, { exp: now / 1_000 - 120 })}`, now),
      ).toMatchObject({
        ok: false,
        reason: 'token expired',
      });
      const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`;
      expect(verifyBearerJwt(SECRET, `Bearer ${none}`, now)).toMatchObject({
        ok: false,
        reason: 'unexpected token algorithm',
      });
      expect(verifyBearerJwt(SECRET, 'Bearer a.b', now)).toMatchObject({ ok: false });
    });
  });

  describe('webhook adapter', () => {
    const config = {
      jira: { clientId: 'id', clientSecret: SECRET },
    } as unknown as AppConfigService;
    const provider = new JiraWebhookProvider(config);
    const query = webhookUrlParams(SECRET, CONNECTION, CLOUD);
    const issue = {
      id: '10001',
      key: 'ENG-7',
      self: 'https://acme.atlassian.net/rest/api/3/issue/10001',
      fields: {
        summary: 'Broken',
        issuetype: { name: 'Bug' },
        project: { key: 'ENG' },
        status: { name: 'Done' },
      },
    };
    const request = (body: object, extra: Record<string, string> = {}) => ({
      headers: {
        authorization: `Bearer ${signJwt(SECRET, { exp: Date.now() / 1_000 + 60 })}`,
        ...extra,
      },
      rawBody: Buffer.from(JSON.stringify(body)),
      body,
      query,
    });

    it('requires both the URL signature and the bearer token', () => {
      const body = { webhookEvent: 'jira:issue_created', issue };
      expect(provider.verify(request(body))).toEqual({ ok: true });
      expect(provider.verify({ ...request(body), query: {} })).toMatchObject({ ok: false });
      expect(provider.verify({ ...request(body), headers: {} })).toMatchObject({ ok: false });
    });

    it('normalises created / updated / transitioned and routes by connection and site', () => {
      const created = provider.normalize(
        request({ webhookEvent: 'jira:issue_created', issue, user: { accountId: 'acc-9' } }),
      )!;
      expect(created).toMatchObject({
        eventType: 'jira.issue.created',
        eventTypes: ['jira.issue.created'],
        resourceKey: CLOUD,
        connectionId: CONNECTION,
        data: {
          event: 'jira.issue.created',
          issue: { key: 'ENG-7', type: 'Bug', url: 'https://acme.atlassian.net/browse/ENG-7' },
          actor: { accountId: 'acc-9' },
          site: { cloudId: CLOUD },
        },
      });
      const moved = provider.normalize(
        request({
          webhookEvent: 'jira:issue_updated',
          issue,
          changelog: {
            id: '5',
            items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }],
          },
        }),
      )!;
      expect(moved.eventTypes).toEqual(['jira.issue.updated', 'jira.issue.transitioned']);
      expect(moved.data).toMatchObject({
        transition: { from: 'In Progress', to: 'Done' },
        changes: [{ field: 'status', from: 'In Progress', to: 'Done' }],
      });
      const edited = provider.normalize(
        request({
          webhookEvent: 'jira:issue_updated',
          issue,
          changelog: { items: [{ field: 'summary' }] },
        }),
      )!;
      expect(edited.eventTypes).toEqual(['jira.issue.updated']);
      expect(provider.normalize(request({ webhookEvent: 'jira:issue_deleted', issue }))).toBeNull();
    });

    it('filters by project, issue type and from/to status', () => {
      const moved = provider.normalize(
        request({
          webhookEvent: 'jira:issue_updated',
          issue,
          changelog: { items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }] },
        }),
      )!;
      expect(provider.matches(moved, { projectKeys: ['ENG'] }, 'jira.issue.updated')).toBe(true);
      expect(provider.matches(moved, { projectKeys: ['OPS'] }, 'jira.issue.updated')).toBe(false);
      expect(
        provider.matches(
          moved,
          { projectKeys: ['ENG'], issueTypes: ['story'] },
          'jira.issue.updated',
        ),
      ).toBe(false);
      expect(
        provider.matches(
          moved,
          { projectKeys: ['ENG'], issueTypes: ['bug'] },
          'jira.issue.updated',
        ),
      ).toBe(true);
      expect(
        provider.matches(
          moved,
          { projectKeys: ['ENG'], toStatus: 'done' },
          'jira.issue.transitioned',
        ),
      ).toBe(true);
      expect(
        provider.matches(
          moved,
          { projectKeys: ['ENG'], toStatus: 'Closed' },
          'jira.issue.transitioned',
        ),
      ).toBe(false);
      expect(
        provider.matches(
          moved,
          { projectKeys: ['ENG'], fromStatus: 'To Do' },
          'jira.issue.transitioned',
        ),
      ).toBe(false);
    });

    it('dedups by Atlassian identifier and event fingerprint (stable across retries)', () => {
      const body = { webhookEvent: 'jira:issue_created', issue, timestamp: 1 };
      const a = provider.deliveryId(request(body, { 'x-atlassian-webhook-identifier': 'w-1' }));
      expect(a).toBe(
        provider.deliveryId(
          request(body, {
            'x-atlassian-webhook-identifier': 'w-1',
            'x-atlassian-webhook-retry': '1',
          }),
        ),
      );
      expect(a).not.toBe(
        provider.deliveryId(
          request({ ...body, timestamp: 2 }, { 'x-atlassian-webhook-identifier': 'w-1' }),
        ),
      );
    });
  });

  describe('node configs (FR-25.3, FR-25.6)', () => {
    const type = (name: string) => JIRA_NODE_TYPES.find((t) => t.type === name)!;
    const base = { connectionId: CONNECTION, siteId: CLOUD };

    it('triggers route by site and connection with their filter', () => {
      const t = type('jira.issue.transitioned');
      const config = {
        ...base,
        projectKeys: ['ENG', 'OPS'],
        issueTypes: ['Bug'],
        toStatus: 'Done',
      };
      expect(t.configSchema.safeParse(config).success).toBe(true);
      expect(t.route!(config)).toEqual({
        provider: 'JIRA',
        eventType: 'jira.issue.transitioned',
        resourceKey: CLOUD,
        connectionId: CONNECTION,
        filter: { projectKeys: ['ENG', 'OPS'], issueTypes: ['Bug'], toStatus: 'Done' },
      });
      expect(
        type('jira.issue.created').configSchema.safeParse({ ...base, projectKeys: [] }).success,
      ).toBe(false);
      expect(
        type('jira.issue.created').configSchema.safeParse({ ...base, projectKeys: ['eng'] })
          .success,
      ).toBe(false);
      expect(
        type('jira.issue.created').configSchema.safeParse({
          ...base,
          projectKeys: ['ENG'],
          toStatus: 'Done',
        }).success,
      ).toBe(false);
    });

    it('validates actions', () => {
      expect(
        type('jira.createIssue').configSchema.safeParse({
          ...base,
          projectKey: 'ENG',
          issueType: 'Bug',
          summary: '{{ trigger.issue.title }}',
        }).success,
      ).toBe(true);
      expect(
        type('jira.createIssue').configSchema.safeParse({
          ...base,
          projectKey: 'ENG',
          issueType: 'Bug',
          summary: 's',
          labels: ['has space'],
        }).success,
      ).toBe(false);
      expect(
        type('jira.createIssue').configSchema.safeParse({
          ...base,
          projectKey: 'ENG',
          issueType: 'Bug',
          summary: 's',
          customFields: { summary: 'x' },
        }).success,
      ).toBe(false);
      expect(
        type('jira.updateIssue').configSchema.safeParse({ ...base, issueKey: 'ENG-1' }).success,
      ).toBe(false);
      expect(
        type('jira.transitionIssue').configSchema.safeParse({ ...base, issueKey: 'ENG-1' }).success,
      ).toBe(false);
      expect(
        type('jira.transitionIssue').configSchema.safeParse({
          ...base,
          issueKey: 'ENG-1',
          toStatus: 'Done',
          transitionId: '31',
        }).success,
      ).toBe(false);
      expect(
        type('jira.transitionIssue').configSchema.safeParse({
          ...base,
          issueKey: 'ENG-1',
          toStatus: 'Done',
        }).success,
      ).toBe(true);
      expect(
        type('jira.searchIssues').configSchema.safeParse({
          ...base,
          jql: 'project = ENG',
          maxResults: 101,
        }).success,
      ).toBe(false);
      expect(
        type('jira.getIssue').configSchema.safeParse({
          ...base,
          issueKey: 'ENG-1',
          url: 'https://x',
        }).success,
      ).toBe(false);
    });
  });

  it('builds one JQL per site from the triggers projects', () => {
    expect(projectsJql(['OPS', 'ENG', 'ENG'])).toBe('project IN ("ENG", "OPS")');
  });
});
