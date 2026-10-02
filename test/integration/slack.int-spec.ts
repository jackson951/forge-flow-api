import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { RunStatus, StepRun } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';
import request, { Response } from 'supertest';
import { App } from 'supertest/types';
import { AppConfigService } from '../../src/config/app-config.service';
import { Env } from '../../src/config/env.schema';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RunQueue } from '../../src/infrastructure/queue/run-queue.service';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { captureLogs } from '../support/canaries';
import { createTestApp } from '../support/create-app';
import { createTestWorker, waitFor } from '../support/create-worker';
import { FakeSlack } from '../support/fake-slack';
import { issuesOpenedPayload } from '../support/github-fixtures';
import { truncateAll } from '../support/test-database';
import { TestNodeControl } from '../support/test-node-types';

const fake = new FakeSlack();
const GITHUB_WEBHOOK_SECRET = 'github-webhook-secret-for-slack-tests';
const INSTALLATION_ID = 777;
const REPO = 'Acme/api';

/** Slack (and the GitHub webhook secret for the flagship flow) point at the fakes. */
class SlackTestConfig extends AppConfigService {
  override get<K extends keyof Env>(key: K): Env[K] {
    const overrides: Partial<Record<keyof Env, string>> = {
      SLACK_CLIENT_ID: fake.clientId,
      SLACK_CLIENT_SECRET: fake.clientSecret,
      SLACK_API_URL: `${fake.url}/api`,
      SLACK_OAUTH_URL: `${fake.url}/oauth/v2/authorize`,
      OAUTH_REDIRECT_BASE_URL: 'http://localhost:3000/api/v1/integrations',
      FRONTEND_URL: 'http://frontend.test',
      GITHUB_WEBHOOK_SECRET,
    };
    return (overrides[key] ?? super.get(key)) as Env[K];
  }
}

describe('Slack integration (integration)', () => {
  let api: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let worker: TestingModule;
  let admin: RegisteredUser;
  let outsider: RegisteredUser;
  let ws: string;
  let slackConnectionId: string;
  let githubConnectionId: string;
  const responses: string[] = [];
  const logged: unknown[][] = [];

  const track = (res: Response) => {
    responses.push(JSON.stringify(res.headers) + res.text);
    return res;
  };
  const asAdmin = () => bearer(admin.accessToken);
  const integrations = (workspace = ws) => `/api/v1/workspaces/${workspace}/integrations`;

  async function startConnect(): Promise<string> {
    const res = track(await request(server).post(`${integrations()}/SLACK/connect`).set(asAdmin()));
    expect(res.status).toBe(201);
    return new URL(res.body.url).searchParams.get('state')!;
  }

  async function callback(query: Record<string, string>): Promise<URL> {
    const res = track(
      await request(server).get('/api/v1/integrations/slack/callback').query(query),
    );
    expect(res.status).toBe(302);
    return new URL(res.headers.location);
  }

  function webhook(title: string, body: string) {
    const payload = issuesOpenedPayload(INSTALLATION_ID, REPO);
    payload.issue.title = title;
    payload.issue.body = body;
    const raw = JSON.stringify(payload);
    return request(server)
      .post('/api/v1/webhooks/github')
      .set({
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': `sha256=${createHmac('sha256', GITHUB_WEBHOOK_SECRET).update(raw).digest('hex')}`,
      })
      .send(raw)
      .then(track);
  }

  let workflowId: string;

  /** Flagship: issue → AI classify (fake) → priority HIGH? → Slack message. */
  async function publishFlagship() {
    const base = `/api/v1/workspaces/${ws}/workflows`;
    const wf = await request(server).post(base).set(asAdmin()).send({ name: 'Flagship' });
    const draft = await request(server)
      .put(`${base}/${wf.body.id}/draft`)
      .set(asAdmin())
      .send({
        expectedRevision: 0,
        definition: {
          schemaVersion: 1,
          nodes: [
            {
              key: 'issue',
              kind: 'TRIGGER',
              type: 'github.issue.created',
              config: { connectionId: githubConnectionId, repository: REPO },
            },
            {
              key: 'classify',
              kind: 'ACTION',
              type: 'ai.classify',
              config: {
                text: '{{ trigger.issue.title }}\n{{ trigger.issue.body }}',
                labels: ['HIGH', 'LOW'],
                field: 'priority',
              },
            },
            {
              key: 'isHigh',
              kind: 'CONDITION',
              type: 'condition',
              config: {
                all: [
                  {
                    left: { ref: 'steps.classify.output.label' },
                    operator: 'equals',
                    right: { value: 'HIGH' },
                  },
                ],
              },
            },
            {
              key: 'notify',
              kind: 'ACTION',
              type: 'slack.sendMessage',
              config: {
                connectionId: slackConnectionId,
                channelId: 'C0GENERAL',
                text: ':rotating_light: {{ steps.classify.output.label }} issue #{{ trigger.issue.number }}: {{ trigger.issue.title }}',
              },
            },
          ],
          edges: [
            { from: 'issue', to: 'classify' },
            { from: 'classify', to: 'isHigh' },
            { from: 'isHigh', to: 'notify', branch: 'true' },
          ],
        },
      });
    expect(draft.body.issues).toEqual([]);
    const published = await request(server)
      .post(`${base}/${wf.body.id}/publish`)
      .set(asAdmin())
      .send({ expectedRevision: 1 })
      .then(track);
    expect(published.status).toBe(201);
    workflowId = wf.body.id;
  }

  /** Sends an issue and waits for the run it starts to finish. */
  async function runIssue(title: string, body = '') {
    const before = await prisma.workflowRun.count({ where: { workflowId } });
    expect((await webhook(title, body)).status).toBe(202);
    const run = await waitFor(
      async () => {
        const runs = await prisma.workflowRun.findMany({
          where: { workflowId },
          orderBy: { createdAt: 'desc' },
          take: 1,
        });
        const latest = runs[0];
        const total = await prisma.workflowRun.count({ where: { workflowId } });
        return total > before && (['SUCCEEDED', 'FAILED'] as RunStatus[]).includes(latest.status)
          ? latest
          : undefined;
      },
      { what: `run for "${title}"` },
    );
    const steps = await prisma.stepRun.findMany({ where: { runId: run.id } });
    return { run, steps: Object.fromEntries(steps.map((s: StepRun) => [s.nodeKey, s])) };
  }

  beforeAll(async () => {
    captureLogs(logged);
    await fake.start();
    const useFakes = (b: TestingModuleBuilder) =>
      b.overrideProvider(AppConfigService).useClass(SlackTestConfig);
    api = await createTestApp(useFakes);
    server = api.getHttpServer();
    prisma = api.get(PrismaService);
    worker = await createTestWorker(new TestNodeControl(), useFakes);
    await truncateAll(prisma);
    admin = await registerUser(server);
    outsider = await registerUser(server);
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: admin.id } }))
      .workspaceId;
    // The GitHub side of the flagship flow is covered by Part 10; connect it directly.
    githubConnectionId = (
      await prisma.integrationConnection.create({
        data: {
          workspaceId: ws,
          provider: 'GITHUB',
          externalAccountId: String(INSTALLATION_ID),
          accountLabel: 'Acme',
          createdById: admin.id,
        },
      })
    ).id;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await worker?.close();
    await api.get(RunQueue).queue.obliterate({ force: true });
    await api.close();
    await fake.stop();
  });

  describe('connect flow (AC-13.2)', () => {
    it('reports Slack as configured and redirects to Slack with scopes and state', async () => {
      const providers = await request(server).get('/api/v1/integrations/providers').set(asAdmin());
      expect(providers.body).toContainEqual({ key: 'SLACK', configured: true });

      const res = track(
        await request(server).post(`${integrations()}/SLACK/connect`).set(asAdmin()),
      );
      const url = new URL(res.body.url);
      expect(url.origin + url.pathname).toBe(`${fake.url}/oauth/v2/authorize`);
      expect(url.searchParams.get('scope')).toBe('chat:write,channels:read,groups:read');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3000/api/v1/integrations/slack/callback',
      );
      expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('non-members cannot start connecting', async () => {
      const res = await request(server)
        .post(`${integrations()}/SLACK/connect`)
        .set(bearer(outsider.accessToken));
      expect(res.status).toBe(404); // not a member of this workspace
    });

    it('stores the bot token encrypted, with team metadata', async () => {
      const state = await startConnect();
      const location = await callback({ code: 'good-slack-code', state });
      expect(location.searchParams.get('status')).toBe('connected');
      slackConnectionId = location.searchParams.get('connectionId')!;

      const connection = await prisma.integrationConnection.findUniqueOrThrow({
        where: { id: slackConnectionId },
        include: { credential: true },
      });
      expect(connection).toMatchObject({
        workspaceId: ws,
        provider: 'SLACK',
        status: 'CONNECTED',
        externalAccountId: 'T0TEAM1',
        accountLabel: 'Acme Corp',
        scopes: ['chat:write', 'channels:read', 'groups:read'],
        metadata: { teamId: 'T0TEAM1', botUserId: 'U0BOT' },
      });
      expect(connection.credential?.encryptedAccessToken).toMatch(/^v1\.test1\./);
      expect(JSON.stringify(connection)).not.toContain(fake.botToken);
    });

    it('rejects a bad state, a reused state and a denied authorization', async () => {
      expect(
        (await callback({ code: 'good-slack-code', state: 'forged' })).searchParams.get('reason'),
      ).toBe('invalid_state');
      const state = await startConnect();
      await callback({ code: 'good-slack-code', state });
      expect((await callback({ code: 'good-slack-code', state })).searchParams.get('reason')).toBe(
        'invalid_state',
      );
      const denied = await startConnect();
      expect(
        (await callback({ error: 'access_denied', state: denied })).searchParams.get('reason'),
      ).toBe('denied');
      const badCode = await startConnect();
      expect((await callback({ code: 'wrong', state: badCode })).searchParams.get('reason')).toBe(
        'provider_error',
      );
    });

    it('re-connecting the same Slack team updates the existing connection (FR-13.3)', async () => {
      const state = await startConnect();
      const location = await callback({ code: 'good-slack-code', state });
      expect(location.searchParams.get('connectionId')).toBe(slackConnectionId);
      expect(await prisma.integrationConnection.count({ where: { provider: 'SLACK' } })).toBe(1);
    });
  });

  describe('channel listing (FR-13.4)', () => {
    const channels = (connectionId: string, token = admin.accessToken, workspace = ws) =>
      request(server)
        .get(`${integrations(workspace)}/${connectionId}/slack/channels`)
        .set(bearer(token))
        .then(track);

    it('returns ids and names only', async () => {
      const res = await channels(slackConnectionId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        items: [
          { id: 'C0GENERAL', name: 'general', isPrivate: false },
          { id: 'G0OPS', name: 'ops', isPrivate: true },
        ],
        nextCursor: null,
      });
    });

    it('is scoped to the workspace and provider', async () => {
      const outsiderWs = (
        await prisma.workspaceMember.findFirstOrThrow({ where: { userId: outsider.id } })
      ).workspaceId;
      expect((await channels(slackConnectionId, outsider.accessToken, outsiderWs)).status).toBe(
        404,
      );
      expect((await channels(slackConnectionId, outsider.accessToken)).status).toBe(404);
      expect((await channels(githubConnectionId)).status).toBe(404);
    });
  });

  describe('flagship workflow (AC-13.1)', () => {
    beforeAll(publishFlagship);

    it('HIGH priority → exactly one Slack message, ts stored as externalRef', async () => {
      const before = fake.messages.length;
      const { run, steps } = await runIssue(
        'Checkout is down for everyone HIGH <!channel>',
        'Prod',
      );

      expect(run.status).toBe('SUCCEEDED');
      expect(steps.classify.sanitizedOutput).toMatchObject({ label: 'HIGH' });
      expect(fake.messages.length).toBe(before + 1);
      const message = fake.messages[fake.messages.length - 1];
      expect(message.channel).toBe('C0GENERAL');
      // Broadcast mention from the issue title is neutralised.
      expect(message.text).toBe(
        ':rotating_light: HIGH issue #42: Checkout is down for everyone HIGH &lt;!channel&gt;',
      );
      expect(steps.notify).toMatchObject({
        status: 'SUCCEEDED',
        externalRef: message.ts,
        sanitizedOutput: { channelId: 'C0GENERAL', ts: message.ts },
      });
    });

    it('LOW priority → no Slack message', async () => {
      const before = fake.messages.length;
      const { run, steps } = await runIssue('Typo in the README', 'LOW impact');
      expect(run.status).toBe('SUCCEEDED');
      expect(steps.classify.sanitizedOutput).toMatchObject({ label: 'LOW' });
      expect(steps.notify.status).toBe('SKIPPED');
      expect(fake.messages.length).toBe(before);
    });

    it('waits for Retry-After on a rate limit, then sends once (AC-13.3)', async () => {
      const before = fake.messages.length;
      fake.postMessageScript.push({ status: 429, headers: { 'retry-after': '1' }, body: {} });
      const { run, steps } = await runIssue('API errors spike HIGH');

      expect(run.status).toBe('SUCCEEDED');
      expect(fake.messages.length).toBe(before + 1);
      const posts = fake.calls.filter((c) => c.method === 'chat.postMessage').slice(-2);
      // QUEUE_BACKOFF_MS is 50 in tests: a ~1 s gap proves the provider's wait was used.
      expect(posts[1].at - posts[0].at).toBeGreaterThanOrEqual(950);
      expect(steps.notify.attemptCount).toBe(2);
    });

    it('a revoked token fails the step as PROVIDER_AUTH and marks the connection NEEDS_ATTENTION (AC-13.4)', async () => {
      fake.revokedTokens.add(fake.botToken);
      const before = fake.messages.length;
      const { run, steps } = await runIssue('Database unreachable HIGH');

      expect(run.status).toBe('FAILED');
      expect(steps.notify).toMatchObject({ status: 'FAILED', errorCategory: 'PROVIDER_AUTH' });
      expect(steps.notify.errorMessage).toMatch(/reconnect Slack/);
      expect(fake.messages.length).toBe(before);
      const connection = await prisma.integrationConnection.findUniqueOrThrow({
        where: { id: slackConnectionId },
      });
      expect(connection.status).toBe('NEEDS_ATTENTION');
      const channels = await request(server)
        .get(`${integrations()}/${slackConnectionId}/slack/channels`)
        .set(asAdmin());
      expect(channels.status).toBe(409);

      // Reconnecting restores it.
      const state = await startConnect();
      await callback({ code: 'good-slack-code', state });
      expect(
        (await prisma.integrationConnection.findUniqueOrThrow({ where: { id: slackConnectionId } }))
          .status,
      ).toBe('CONNECTED');
      expect((await runIssue('Database unreachable again HIGH')).run.status).toBe('SUCCEEDED');
    });

    it('a channel the bot is not in fails permanently with an actionable message', async () => {
      fake.postMessageScript.push({ body: { ok: false, error: 'not_in_channel' } });
      const { run, steps } = await runIssue('Search is broken HIGH');
      expect(run.status).toBe('FAILED');
      expect(steps.notify).toMatchObject({
        errorCategory: 'PERMANENT_PROVIDER_ERROR',
        attemptCount: 1,
      });
      expect(steps.notify.errorMessage).toMatch(/invite it with \/invite/);
    });
  });

  describe('disconnect (FR-13.9)', () => {
    it('revokes the token at Slack and deletes the stored credential', async () => {
      const res = track(
        await request(server).delete(`${integrations()}/${slackConnectionId}`).set(asAdmin()),
      );
      expect(res.status).toBe(204);
      expect(fake.revokedTokens.has(fake.botToken)).toBe(true);
      expect(
        await prisma.integrationCredential.count({ where: { connectionId: slackConnectionId } }),
      ).toBe(0);
      const audit = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'integration.disconnected', targetId: slackConnectionId },
      });
      expect(audit.metadata).toMatchObject({ provider: 'SLACK', revokedAtProvider: true });
    });
  });

  it('never exposes the bot token or client secret in responses or logs (AC-13.6)', async () => {
    const all = responses.join('\n');
    expect(responses.length).toBeGreaterThan(10);
    expect(all).not.toContain(fake.botToken);
    expect(all).not.toContain(fake.clientSecret);

    const logs = JSON.stringify(logged);
    expect(logs).toContain('Slack message posted');
    expect(logs).not.toContain(fake.botToken);
    expect(logs).not.toContain(fake.clientSecret);
    expect(logs).not.toContain('good-slack-code');

    const steps = await prisma.stepRun.findMany({
      select: { sanitizedInput: true, sanitizedOutput: true, errorMessage: true },
    });
    expect(JSON.stringify(steps)).not.toContain(fake.botToken);
  });
});
