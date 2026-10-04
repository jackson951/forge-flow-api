import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppConfigService } from '../../src/config/app-config.service';
import { Env } from '../../src/config/env.schema';
import { JiraSubscriptionsService } from '../../src/execution/jira-subscriptions.service';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RunQueue } from '../../src/infrastructure/queue/run-queue.service';
import { JiraTokenManager } from '../../src/modules/integrations/jira/jira-token-manager';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { captureLogs, expectNoSecrets } from '../support/canaries';
import { createTestApp } from '../support/create-app';
import { createTestWorker, waitFor } from '../support/create-worker';
import { FakeJira } from '../support/fake-jira';
import { truncateAll } from '../support/test-database';
import { TestNodeControl } from '../support/test-node-types';

const fake = new FakeJira();
const DAY = 86_400_000;

class JiraTestConfig extends AppConfigService {
  override get<K extends keyof Env>(key: K): Env[K] {
    const overrides: Partial<Record<keyof Env, unknown>> = {
      JIRA_CLIENT_ID: fake.clientId,
      JIRA_CLIENT_SECRET: fake.clientSecret,
      JIRA_AUTH_URL: fake.url,
      JIRA_API_URL: fake.url,
      OAUTH_REDIRECT_BASE_URL: 'http://localhost:3000/api/v1/integrations',
      FRONTEND_URL: 'http://frontend.test',
    };
    return (overrides[key] ?? super.get(key)) as Env[K];
  }
}

/**
 * Part 25 — Jira Cloud against a simulated Atlassian (OAuth 3LO, REST v3, dynamic webhooks):
 * AC-25.1 connect/refresh/revoke/disconnect, AC-25.2 actions, AC-25.3 triggers, AC-25.4
 * webhook lifecycle and renewal, AC-25.5 error handling.
 */
describe('Jira Cloud integration (integration)', () => {
  let api: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let worker: TestingModule;
  let admin: RegisteredUser;
  let ws: string;
  let connectionId: string;
  const logs = captureLogs();

  const auth = () => bearer(admin.accessToken);
  const integrations = (workspace = ws) => `/api/v1/workspaces/${workspace}/integrations`;
  const workflows = () => `/api/v1/workspaces/${ws}/workflows`;
  const subscriptions = () => worker.get(JiraSubscriptionsService);

  /** The browser round trip: Atlassian issues a code; the callback stores the connection. */
  async function connect(user: RegisteredUser = admin, workspace = ws): Promise<URL> {
    const start = await request(server)
      .post(`${integrations(workspace)}/JIRA/connect`)
      .set(bearer(user.accessToken))
      .expect(201);
    const authorize = new URL(start.body.url);
    const done = await request(server)
      .get('/api/v1/integrations/jira/callback')
      .query({ code: fake.issueCode(), state: authorize.searchParams.get('state')! })
      .expect(302);
    return new URL(done.headers.location);
  }

  async function publish(
    nodes: object[],
    edges: object[],
    workspace = ws,
    user = admin,
  ): Promise<string> {
    const base = `/api/v1/workspaces/${workspace}/workflows`;
    const wf = await request(server)
      .post(base)
      .set(bearer(user.accessToken))
      .send({ name: 'jira' })
      .expect(201);
    const draft = await request(server)
      .put(`${base}/${wf.body.id}/draft`)
      .set(bearer(user.accessToken))
      .send({ expectedRevision: 0, definition: { schemaVersion: 1, nodes, edges } })
      .expect(200);
    expect(draft.body.issues).toEqual([]);
    await request(server)
      .post(`${base}/${wf.body.id}/publish`)
      .set(bearer(user.accessToken))
      .send({ expectedRevision: 1 })
      .expect(201);
    return wf.body.id;
  }

  const manual = { key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger', config: {} };
  const jiraNode = (key: string, type: string, config: object, conn = connectionId) => ({
    key,
    kind: 'ACTION',
    type,
    config: { connectionId: conn, siteId: fake.cloudId, ...config },
  });
  const chain = (...nodes: { key: string }[]) =>
    nodes.slice(1).map((n, i) => ({ from: nodes[i].key, to: n.key }));

  async function runManual(nodes: { key: string }[], input: object = {}) {
    const id = await publish([manual, ...nodes], chain(manual, ...nodes));
    const res = await request(server)
      .post(`${workflows()}/${id}/runs`)
      .set(auth())
      .send({ input })
      .expect(202);
    return settled(res.body.runId);
  }

  async function settled(runId: string) {
    const run = await waitFor(
      async () => {
        const r = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });
        return ['SUCCEEDED', 'FAILED'].includes(r.status) ? r : undefined;
      },
      { timeoutMs: 30_000, what: `run ${runId}` },
    );
    const steps = await prisma.stepRun.findMany({ where: { runId }, orderBy: { sequence: 'asc' } });
    return { run, steps, step: (key: string) => steps.find((s) => s.nodeKey === key)! };
  }

  /** Delivers a Jira webhook to the URL registered at the fake. */
  const deliver = (
    body: object,
    headers: Record<string, string> = {},
    path = fake.registeredWebhook()!.path,
  ) =>
    request(server)
      .post(path)
      .set({
        'content-type': 'application/json',
        authorization: fake.webhookAuthorization(),
        ...headers,
      })
      .send(JSON.stringify(body));

  const issuePayload = (event: string, key: string, extra: object = {}) => ({
    webhookEvent: event,
    timestamp: Date.now(),
    issue: {
      id: '10001',
      key,
      self: `${fake.siteUrl}/rest/api/3/issue/10001`,
      fields: {
        summary: 'Login broken',
        issuetype: { name: 'Bug' },
        project: { key: key.split('-')[0] },
        status: { name: 'Done' },
        description: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'details' }] }],
        },
      },
    },
    user: { accountId: 'acc-actor', displayName: 'Grace' },
    ...extra,
  });

  beforeAll(async () => {
    await fake.start();
    const useFakes = (b: TestingModuleBuilder) =>
      b.overrideProvider(AppConfigService).useClass(JiraTestConfig);
    api = await createTestApp(useFakes);
    server = api.getHttpServer();
    prisma = api.get(PrismaService);
    worker = await createTestWorker(new TestNodeControl(), useFakes);
    await truncateAll(prisma);
    admin = await registerUser(server);
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: admin.id } }))
      .workspaceId;
  });

  afterAll(async () => {
    await worker?.close();
    await api.get(RunQueue).queue.obliterate({ force: true });
    await api.close();
    await fake.stop();
    jest.restoreAllMocks();
  });

  describe('connect (FR-25.1/25.2, AC-25.1)', () => {
    it('authorizes with the documented 3LO parameters and stores one connection with its sites', async () => {
      const providers = await request(server)
        .get('/api/v1/integrations/providers')
        .set(auth())
        .expect(200);
      expect(providers.body).toContainEqual({
        key: 'JIRA',
        configured: true,
        connectionType: 'OAUTH',
      });

      const start = await request(server)
        .post(`${integrations()}/JIRA/connect`)
        .set(auth())
        .expect(201);
      const authorize = new URL(start.body.url);
      expect(`${authorize.origin}${authorize.pathname}`).toBe(`${fake.url}/authorize`);
      expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
        audience: 'api.atlassian.com',
        client_id: fake.clientId,
        scope:
          'read:jira-work write:jira-work read:jira-user manage:jira-webhook read:me offline_access',
        redirect_uri: 'http://localhost:3000/api/v1/integrations/jira/callback',
        response_type: 'code',
        prompt: 'consent',
        state: expect.any(String),
      });

      const done = await connect();
      expect(done.searchParams.get('status')).toBe('connected');
      connectionId = done.searchParams.get('connectionId')!;
      const list = await request(server).get(integrations()).set(auth()).expect(200);
      expect(list.body.find((c: { id: string }) => c.id === connectionId)).toMatchObject({
        provider: 'JIRA',
        status: 'CONNECTED',
        statusReason: null,
        externalAccountId: fake.accountId,
        accountLabel: 'ada@acme.test',
        metadata: { sites: [{ cloudId: fake.cloudId, name: 'acme', url: fake.siteUrl }] }, // Confluence-only site left out
      });
      const stored = await prisma.integrationCredential.findUniqueOrThrow({
        where: { connectionId },
      });
      expectNoSecrets([stored, list.body], [...fake.validAccessTokens, ...fake.validRefreshTokens]);
    });

    it('refuses a grant without the required scopes', async () => {
      fake.grantedScopes = 'read:jira-work offline_access';
      try {
        const done = await connect();
        expect(done.searchParams.get('status')).toBe('error');
        expect(done.searchParams.get('reason')).toBe('not_authorized');
      } finally {
        fake.grantedScopes =
          'read:jira-work write:jira-work read:jira-user manage:jira-webhook read:me offline_access';
      }
    });

    it('refreshes with rotation, once for concurrent callers', async () => {
      await prisma.integrationCredential.update({
        where: { connectionId },
        data: { accessTokenExpiresAt: new Date(Date.now() - 1_000) },
      });
      const before = fake.refreshCalls.length;
      fake.refreshDelayMs = 150;
      const tokens = api.get(JiraTokenManager);
      const [a, b] = await Promise.all([
        tokens.accessToken(ws, connectionId),
        tokens.accessToken(ws, connectionId),
      ]);
      fake.refreshDelayMs = 0;
      expect(a).toBe(b);
      expect(fake.refreshCalls.length - before).toBe(1);
      // The previous refresh token no longer works at the provider (rotation), the new one is stored.
      expect(fake.validRefreshTokens.has(fake.refreshCalls.at(-1)!)).toBe(false);
    });
  });

  describe('actions (FR-25.6, AC-25.2)', () => {
    it('create → comment → transition → assign → update → get → search, with ADF and normalised outputs', async () => {
      const { run, step } = await runManual(
        [
          jiraNode('create', 'jira.createIssue', {
            projectKey: 'ENG',
            issueType: 'Bug',
            summary: 'From {{ trigger.source }}',
            description: 'Line one\nline two\n\nSecond paragraph',
            priority: 'High',
            labels: ['flowforge'],
            customFields: { customfield_10010: 'sprint-7' },
          }),
          jiraNode('comment', 'jira.addComment', {
            issueKey: '{{ steps.create.output.key }}',
            text: 'Created by FlowForge',
          }),
          jiraNode('move', 'jira.transitionIssue', {
            issueKey: '{{ steps.create.output.key }}',
            toStatus: 'done',
          }),
          jiraNode('assign', 'jira.assignIssue', {
            issueKey: '{{ steps.create.output.key }}',
            assigneeAccountId: 'acc-1',
          }),
          jiraNode('update', 'jira.updateIssue', {
            issueKey: '{{ steps.create.output.key }}',
            summary: 'Renamed',
          }),
          jiraNode('get', 'jira.getIssue', { issueKey: '{{ steps.create.output.key }}' }),
          jiraNode('search', 'jira.searchIssues', { jql: 'project = ENG', maxResults: 10 }),
        ],
        { source: 'GitHub' },
      );
      expect(run.status).toBe('SUCCEEDED');
      const create = fake.calls.find((c) => c.method === 'POST' && c.path === '/issue')!;
      expect(create.body).toMatchObject({
        fields: {
          project: { key: 'ENG' },
          issuetype: { name: 'Bug' },
          summary: 'From GitHub',
          priority: { name: 'High' },
          labels: ['flowforge'],
          customfield_10010: 'sprint-7',
          description: {
            type: 'doc',
            version: 1,
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'Line one' },
                  { type: 'hardBreak' },
                  { type: 'text', text: 'line two' },
                ],
              },
              { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph' }] },
            ],
          },
        },
      });
      const key = (step('create').sanitizedOutput as { key: string }).key;
      expect(step('create').sanitizedOutput).toMatchObject({
        key,
        summary: 'From GitHub',
        url: `${fake.siteUrl}/browse/${key}`,
        status: 'To Do',
      });
      expect(step('move').sanitizedOutput).toEqual({
        issueKey: key,
        transitionId: '31',
        toStatus: 'Done',
      });
      expect(step('get').sanitizedOutput).toMatchObject({
        key,
        summary: 'Renamed',
        status: 'Done',
        assignee: { accountId: 'acc-1' },
      });
      expect(step('search').sanitizedOutput).toMatchObject({
        count: expect.any(Number),
        hasMore: false,
        issues: expect.arrayContaining([expect.objectContaining({ key })]),
      });
      expect(fake.calls.find((c) => c.path.endsWith('/comment'))!.body).toMatchObject({
        body: { type: 'doc' },
      });
    });

    it('a rendered issue key that is not an issue key never reaches Jira', async () => {
      const before = fake.calls.length;
      const { run } = await runManual(
        [jiraNode('get', 'jira.getIssue', { issueKey: '{{ trigger.k }}' })],
        { k: '../../myself' },
      );
      expect(run).toMatchObject({ status: 'FAILED', lastErrorCategory: 'VALIDATION' });
      expect(fake.calls.length).toBe(before);
    });

    it('a site outside the connection is refused', async () => {
      const node = jiraNode('get', 'jira.getIssue', { issueKey: 'ENG-1' });
      (node.config as { siteId: string }).siteId = 'someone-elses-site';
      const { run } = await runManual([node]);
      expect(run).toMatchObject({ status: 'FAILED', lastErrorCategory: 'VALIDATION' });
    });
  });

  describe('errors (AC-25.5)', () => {
    beforeAll(() =>
      fake.addIssue('ENG-900', {
        summary: 's',
        project: { key: 'ENG' },
        status: { name: 'To Do' },
      }),
    );

    it('a 5xx on create is UNCERTAIN_OUTCOME and not sent again', async () => {
      fake.apiScript.push({ path: '/issue', status: 502, body: {} });
      const before = fake.calls.filter((c) => c.method === 'POST' && c.path === '/issue').length;
      const { run } = await runManual([
        jiraNode('create', 'jira.createIssue', {
          projectKey: 'ENG',
          issueType: 'Bug',
          summary: 's',
        }),
      ]);
      expect(run).toMatchObject({ status: 'FAILED', lastErrorCategory: 'UNCERTAIN_OUTCOME' });
      expect(
        fake.calls.filter((c) => c.method === 'POST' && c.path === '/issue').length - before,
      ).toBe(1);
    });

    it('reads are retried on 5xx and 429 (Retry-After)', async () => {
      fake.apiScript.push(
        { path: '/search/jql', status: 500, body: {} },
        { path: '/search/jql', status: 429, headers: { 'retry-after': '1' }, body: {} },
      );
      const { run } = await runManual([
        jiraNode('search', 'jira.searchIssues', { jql: 'project = ENG' }),
      ]);
      expect(run.status).toBe('SUCCEEDED');
    });

    it('403 is AUTHORIZATION, 404 permanent, 400 carries Jira field messages', async () => {
      fake.apiScript.push({ path: '/issue/ENG-900', status: 403, body: {} });
      expect(
        (await runManual([jiraNode('g', 'jira.getIssue', { issueKey: 'ENG-900' })])).run,
      ).toMatchObject({ status: 'FAILED', lastErrorCategory: 'AUTHORIZATION' });
      expect(
        (await runManual([jiraNode('g', 'jira.getIssue', { issueKey: 'ENG-404' })])).run,
      ).toMatchObject({ status: 'FAILED', lastErrorCategory: 'PERMANENT_PROVIDER_ERROR' });
      fake.apiScript.push({
        path: '/issue',
        status: 400,
        body: { errors: { summary: 'You must specify a summary of the issue.' } },
      });
      const bad = await runManual([
        jiraNode('c', 'jira.createIssue', { projectKey: 'ENG', issueType: 'Bug', summary: 'x' }),
      ]);
      expect(bad.run).toMatchObject({ status: 'FAILED', lastErrorCategory: 'VALIDATION' });
      expect(bad.run.errorMessage).toContain('summary: You must specify a summary of the issue.');
    });

    it('a 401 forces one refresh and a retry', async () => {
      fake.apiScript.push({ path: '/issue/ENG-900', status: 401, body: {} });
      const before = fake.refreshCalls.length;
      const { run } = await runManual([jiraNode('g', 'jira.getIssue', { issueKey: 'ENG-900' })]);
      expect(run.status).toBe('SUCCEEDED');
      expect(fake.refreshCalls.length - before).toBe(1);
    });
  });

  describe('triggers and webhook lifecycle (FR-25.3–25.5, FR-25.8, AC-25.3, AC-25.4)', () => {
    let createdWorkflow: string;
    const trigger = (type: string, config: object = {}) => ({
      key: 'trigger',
      kind: 'TRIGGER',
      type,
      config: { connectionId, siteId: fake.cloudId, projectKeys: ['ENG'], ...config },
    });
    const log = {
      key: 'log',
      kind: 'ACTION',
      type: 'util.log',
      config: { message: '{{ trigger.issue.key }} {{ trigger.event }}' },
    };
    const runsOf = (workflowId: string) =>
      prisma.workflowRun.findMany({ where: { workflowId }, orderBy: { createdAt: 'asc' } });

    it('publishing registers one webhook for the connection and site, with the projects JQL', async () => {
      createdWorkflow = await publish(
        [trigger('jira.issue.created'), log],
        [{ from: 'trigger', to: 'log' }],
      );
      const hook = await waitFor(async () => fake.registeredWebhook(), {
        what: 'the Jira webhook registration',
      });
      expect(hook.jqlFilter).toBe('project IN ("ENG")');
      expect(hook.path).toMatch(/^\/api\/v1\/webhooks\/jira\?c=.+&s=cloud-1111-2222&sig=/);
      expect([...fake.webhooks.values()][0].events).toEqual([
        'jira:issue_created',
        'jira:issue_updated',
      ]);
      const sub = await prisma.providerSubscription.findFirstOrThrow({ where: { connectionId } });
      expect(sub).toMatchObject({
        provider: 'JIRA',
        resourceKey: fake.cloudId,
        status: 'ACTIVE',
        consecutiveFailures: 0,
      });
      expect(sub.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
    });

    it('a delivery creates one run with the normalised issue; duplicates and other projects do not', async () => {
      const identifier = { 'x-atlassian-webhook-identifier': 'wh-1' };
      const payload = issuePayload('jira:issue_created', 'ENG-42');
      const res = await deliver(payload, identifier).expect(202);
      expect(res.body.runs).toBe(1);
      const [run] = await runsOf(createdWorkflow);
      const done = await settled(run.id);
      expect(done.run.status).toBe('SUCCEEDED');
      expect(done.run.triggerInput).toMatchObject({
        event: 'jira.issue.created',
        issue: {
          key: 'ENG-42',
          summary: 'Login broken',
          type: 'Bug',
          description: 'details',
          url: `${fake.siteUrl}/browse/ENG-42`,
        },
        actor: { accountId: 'acc-actor' },
        site: { cloudId: fake.cloudId },
      });
      expect(done.step('log').sanitizedOutput).toEqual({ message: 'ENG-42 jira.issue.created' });

      // Atlassian retry of the same delivery: no new run.
      const dup = await deliver(payload, { ...identifier, 'x-atlassian-webhook-retry': '1' });
      expect(dup.body.duplicate).toBe(true);
      // Another project of the site: not this trigger's.
      await deliver(issuePayload('jira:issue_created', 'OPS-1'), {
        'x-atlassian-webhook-identifier': 'wh-2',
      }).expect(202);
      expect(await runsOf(createdWorkflow)).toHaveLength(1);
    });

    it("rejects deliveries without Atlassian's token or with a tampered URL", async () => {
      const path = fake.registeredWebhook()!.path;
      await deliver(issuePayload('jira:issue_created', 'ENG-43'), {
        authorization: fake.webhookAuthorization('wrong-secret'),
      }).expect(401);
      await deliver(
        issuePayload('jira:issue_created', 'ENG-43'),
        {},
        path.replace(/sig=[^&]+/, 'sig=AAAA'),
      ).expect(401);
      await deliver(
        issuePayload('jira:issue_created', 'ENG-43'),
        {},
        path.replace(/s=[^&]+/, 's=other-site'),
      ).expect(401);
    });

    it('transitioned triggers filter on the status change', async () => {
      const id = await publish(
        [trigger('jira.issue.transitioned', { toStatus: 'Done' }), log],
        [{ from: 'trigger', to: 'log' }],
      );
      await waitFor(async () =>
        fake.registeredWebhook()?.jqlFilter === 'project IN ("ENG")' ? true : undefined,
      );
      const edit = issuePayload('jira:issue_updated', 'ENG-50', {
        changelog: { id: '1', items: [{ field: 'summary', fromString: 'a', toString: 'b' }] },
      });
      await deliver(edit, { 'x-atlassian-webhook-identifier': 'wh-10' }).expect(202);
      const toProgress = issuePayload('jira:issue_updated', 'ENG-50', {
        changelog: {
          id: '2',
          items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }],
        },
      });
      await deliver(toProgress, { 'x-atlassian-webhook-identifier': 'wh-11' }).expect(202);
      expect(await runsOf(id)).toHaveLength(0);
      const toDone = issuePayload('jira:issue_updated', 'ENG-50', {
        changelog: {
          id: '3',
          items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }],
        },
      });
      await deliver(toDone, { 'x-atlassian-webhook-identifier': 'wh-12' }).expect(202);
      const [run] = await runsOf(id);
      expect(run.triggerInput).toMatchObject({
        event: 'jira.issue.transitioned',
        transition: { from: 'In Progress', to: 'Done' },
      });
    });

    it('a second workspace connected to the same Atlassian account never receives this webhook', async () => {
      const other = await registerUser(server);
      const otherWs = (
        await prisma.workspaceMember.findFirstOrThrow({ where: { userId: other.id } })
      ).workspaceId;
      const otherConnection = new URL((await connect(other, otherWs)).toString()).searchParams.get(
        'connectionId',
      )!;
      const otherWorkflow = await publish(
        [
          {
            key: 'trigger',
            kind: 'TRIGGER',
            type: 'jira.issue.created',
            config: { connectionId: otherConnection, siteId: fake.cloudId, projectKeys: ['ENG'] },
          },
          log,
        ],
        [{ from: 'trigger', to: 'log' }],
        otherWs,
        other,
      );
      const firstPath =
        (await prisma.providerSubscription.findFirstOrThrow({ where: { connectionId } })) &&
        fake.registeredWebhook()!.path;
      // Deliver to the first workspace's webhook URL (by connection id in the URL).
      const mine = [...fake.webhooks.values()].find((h) => h.url.includes(`c=${connectionId}`))!;
      const url = new URL(mine.url);
      await deliver(
        issuePayload('jira:issue_created', 'ENG-77'),
        { 'x-atlassian-webhook-identifier': 'wh-20' },
        `${url.pathname}${url.search}`,
      ).expect(202);
      expect(await prisma.workflowRun.count({ where: { workflowId: otherWorkflow } })).toBe(0);
      expect(firstPath).toBeTruthy();
    });

    it('a new version with more projects re-registers; archiving the last trigger removes the webhook', async () => {
      const subs = subscriptions();
      // Archive the other ENG triggers of this connection so only `createdWorkflow` remains.
      const others = await prisma.workflowTrigger.findMany({
        where: { connectionId, workflowId: { not: createdWorkflow } },
      });
      for (const t of others)
        await request(server)
          .post(`${workflows()}/${t.workflowId}/archive`)
          .set(auth())
          .expect(200);

      const wf = await request(server).get(`${workflows()}/${createdWorkflow}`).set(auth());
      const definition = wf.body.draftDefinition;
      definition.nodes[0].config.projectKeys = ['ENG', 'OPS'];
      const draft = await request(server)
        .put(`${workflows()}/${createdWorkflow}/draft`)
        .set(auth())
        .send({ expectedRevision: wf.body.draftRevision, definition })
        .expect(200);
      await request(server)
        .post(`${workflows()}/${createdWorkflow}/publish`)
        .set(auth())
        .send({ expectedRevision: draft.body.draftRevision })
        .expect(201);
      await subs.run(ws);
      const mine = () =>
        [...fake.webhooks.values()].filter((h) => h.url.includes(`c=${connectionId}`));
      expect(mine().map((h) => h.jqlFilter)).toEqual(['project IN ("ENG", "OPS")']);

      await request(server)
        .post(`${workflows()}/${createdWorkflow}/archive`)
        .set(auth())
        .expect(200);
      await subs.run(ws);
      expect(mine()).toEqual([]);
      expect(await prisma.providerSubscription.count({ where: { connectionId } })).toBe(0);

      await request(server)
        .post(`${workflows()}/${createdWorkflow}/unarchive`)
        .set(auth())
        .expect(200);
      await subs.run(ws);
      expect(mine()).toHaveLength(1);
    });

    it('concurrent syncs after a change leave exactly one webhook (no orphans at Jira)', async () => {
      const wf = await request(server).get(`${workflows()}/${createdWorkflow}`).set(auth());
      const definition = wf.body.draftDefinition;
      definition.nodes[0].config.projectKeys = ['ENG', 'OPS', 'SEC'];
      const draft = await request(server)
        .put(`${workflows()}/${createdWorkflow}/draft`)
        .set(auth())
        .send({ expectedRevision: wf.body.draftRevision, definition })
        .expect(200);
      await request(server)
        .post(`${workflows()}/${createdWorkflow}/publish`)
        .set(auth())
        .send({ expectedRevision: draft.body.draftRevision })
        .expect(201);
      await Promise.all([subscriptions().run(ws), subscriptions().run(ws), subscriptions().run()]);
      const mine = [...fake.webhooks.values()].filter((h) => h.url.includes(`c=${connectionId}`));
      expect(mine.map((h) => h.jqlFilter)).toEqual(['project IN ("ENG", "OPS", "SEC")']);
    });

    it('renews webhooks before expiry; 3 failures flag the connection, a success clears it', async () => {
      const subs = subscriptions();
      const sub = await prisma.providerSubscription.findFirstOrThrow({ where: { connectionId } });
      await prisma.providerSubscription.update({
        where: { id: sub.id },
        data: { expiresAt: new Date(Date.now() + 2 * DAY) },
      });
      await subs.run(ws);
      const renewed = await prisma.providerSubscription.findUniqueOrThrow({
        where: { id: sub.id },
      });
      expect(renewed.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
      expect(fake.calls.some((c) => c.method === 'PUT' && c.path === '/webhook/refresh')).toBe(
        true,
      );

      await prisma.providerSubscription.update({
        where: { id: sub.id },
        data: { expiresAt: new Date(Date.now() + DAY) },
      });
      for (let i = 0; i < 3; i++) {
        fake.apiScript.push({ path: '/webhook/refresh', status: 500, body: {} });
        await subs.run(ws);
      }
      expect(
        await prisma.providerSubscription.findUniqueOrThrow({ where: { id: sub.id } }),
      ).toMatchObject({ consecutiveFailures: 3, status: 'FAILING' });
      expect(
        await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } }),
      ).toMatchObject({
        status: 'NEEDS_ATTENTION',
        statusReason: 'WATCH_RENEWAL_FAILED',
      });
      await subs.run(ws); // the provider works again
      expect(
        await prisma.providerSubscription.findUniqueOrThrow({ where: { id: sub.id } }),
      ).toMatchObject({ consecutiveFailures: 0, status: 'ACTIVE' });
      expect(
        await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } }),
      ).toMatchObject({ status: 'CONNECTED', statusReason: null });
    });
  });

  describe('pickers and tenant isolation (FR-25.9)', () => {
    it('lists projects, issue types, statuses and users with minimal fields', async () => {
      const q = `siteId=${fake.cloudId}`;
      const sites = await request(server)
        .get(`${integrations()}/${connectionId}/jira/sites`)
        .set(auth())
        .expect(200);
      expect(sites.body).toEqual([{ cloudId: fake.cloudId, name: 'acme', url: fake.siteUrl }]);
      const projects = await request(server)
        .get(`${integrations()}/${connectionId}/jira/projects?${q}`)
        .set(auth())
        .expect(200);
      expect(projects.body).toEqual([{ id: '1', key: 'ENG', name: 'Engineering' }]);
      const types = await request(server)
        .get(`${integrations()}/${connectionId}/jira/issue-types?${q}&project=ENG`)
        .set(auth())
        .expect(200);
      expect(types.body).toEqual([
        { id: '10001', name: 'Bug', subtask: false },
        { id: '10002', name: 'Sub-task', subtask: true },
      ]);
      const statuses = await request(server)
        .get(`${integrations()}/${connectionId}/jira/statuses?${q}&project=ENG`)
        .set(auth())
        .expect(200);
      expect(statuses.body).toEqual([
        { id: '1', name: 'To Do' },
        { id: '3', name: 'Done' },
      ]);
      const users = await request(server)
        .get(`${integrations()}/${connectionId}/jira/users?${q}&project=ENG&query=a`)
        .set(auth())
        .expect(200);
      expect(users.body).toEqual([{ accountId: 'acc-1', displayName: 'Ada' }]); // no e-mail, inactive left out
      await request(server)
        .get(`${integrations()}/${connectionId}/jira/projects?siteId=not-mine`)
        .set(auth())
        .expect(422);
    });

    it('another workspace cannot use the connection (pickers, publish)', async () => {
      const other = await registerUser(server);
      const otherWs = (
        await prisma.workspaceMember.findFirstOrThrow({ where: { userId: other.id } })
      ).workspaceId;
      await request(server)
        .get(`${integrations(otherWs)}/${connectionId}/jira/projects?siteId=${fake.cloudId}`)
        .set(bearer(other.accessToken))
        .expect(404);
      const base = `/api/v1/workspaces/${otherWs}/workflows`;
      const wf = await request(server)
        .post(base)
        .set(bearer(other.accessToken))
        .send({ name: 'x' })
        .expect(201);
      const definition = {
        schemaVersion: 1,
        nodes: [manual, jiraNode('g', 'jira.getIssue', { issueKey: 'ENG-1' })],
        edges: [{ from: 'trigger', to: 'g' }],
      };
      await request(server)
        .put(`${base}/${wf.body.id}/draft`)
        .set(bearer(other.accessToken))
        .send({ expectedRevision: 0, definition })
        .expect(200);
      const res = await request(server)
        .post(`${base}/${wf.body.id}/publish`)
        .set(bearer(other.accessToken))
        .send({ expectedRevision: 1 })
        .expect(422);
      expect(res.body.details).toEqual([expect.objectContaining({ code: 'CONNECTION_INVALID' })]);
    });
  });

  describe('revocation and disconnect (AC-25.1)', () => {
    it('a revoked grant marks the connection TOKEN_REVOKED; reconnecting heals it', async () => {
      await prisma.integrationCredential.update({
        where: { connectionId },
        data: { accessTokenExpiresAt: new Date(Date.now() - 1_000) },
      });
      fake.tokenScript.push({ status: 403, body: { error: 'invalid_grant' } });
      const { run } = await runManual([jiraNode('g', 'jira.getIssue', { issueKey: 'ENG-900' })]);
      expect(run).toMatchObject({ status: 'FAILED', lastErrorCategory: 'PROVIDER_AUTH' });
      expect(
        await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } }),
      ).toMatchObject({
        status: 'NEEDS_ATTENTION',
        statusReason: 'TOKEN_REVOKED',
      });
      const again = await connect();
      expect(again.searchParams.get('connectionId')).toBe(connectionId); // same connection, new tokens
      expect(
        await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } }),
      ).toMatchObject({ status: 'CONNECTED', statusReason: null });
    });

    it('disconnect deletes the webhooks at Jira and the stored tokens', async () => {
      await subscriptions().run(ws);
      expect([...fake.webhooks.values()].some((h) => h.url.includes(`c=${connectionId}`))).toBe(
        true,
      );
      await request(server).delete(`${integrations()}/${connectionId}`).set(auth()).expect(204);
      expect([...fake.webhooks.values()].some((h) => h.url.includes(`c=${connectionId}`))).toBe(
        false,
      );
      expect(await prisma.integrationCredential.count({ where: { connectionId } })).toBe(0);
      expect(await prisma.providerSubscription.count({ where: { connectionId } })).toBe(0);
    });

    it('never logs tokens or the client secret', () => {
      expectNoSecrets(logs, [
        fake.clientSecret,
        ...fake.validAccessTokens,
        ...fake.validRefreshTokens,
      ]);
    });
  });
});
