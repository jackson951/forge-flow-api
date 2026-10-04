import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppConfigService } from '../../src/config/app-config.service';
import { Env } from '../../src/config/env.schema';
import { GmailSyncService } from '../../src/execution/gmail-sync.service';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RunQueue } from '../../src/infrastructure/queue/run-queue.service';
import { REDIS_CLIENT } from '../../src/infrastructure/redis/redis.module';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { captureLogs, expectNoSecrets } from '../support/canaries';
import { createTestApp } from '../support/create-app';
import { createTestWorker, waitFor } from '../support/create-worker';
import { FakeGoogle } from '../support/fake-google';
import { truncateAll } from '../support/test-database';
import { TestNodeControl } from '../support/test-node-types';

const fake = new FakeGoogle();
const DAY = 86_400_000;
// Email content canaries: must never reach logs.
const BODY_CANARY = ['secret', 'customer', 'body', 'canary', '41f'].join('-');
const SUBJECT_CANARY = ['private', 'subject', 'canary'].join('-');

class GmailTestConfig extends AppConfigService {
  override get<K extends keyof Env>(key: K): Env[K] {
    const overrides: Partial<Record<keyof Env, unknown>> = {
      GOOGLE_CLIENT_ID: fake.clientId,
      GOOGLE_CLIENT_SECRET: fake.clientSecret,
      GOOGLE_AUTH_URL: `${fake.url}/authorize`,
      GOOGLE_TOKEN_URL: `${fake.url}/token`,
      GOOGLE_REVOKE_URL: `${fake.url}/revoke`,
      GOOGLE_USERINFO_URL: `${fake.url}/userinfo`,
      GOOGLE_JWKS_URL: `${fake.url}/certs`,
      GMAIL_API_URL: `${fake.url}/gmail/v1`,
      GMAIL_PUBSUB_TOPIC: fake.topic,
      GMAIL_PUSH_AUDIENCE: fake.audience,
      GMAIL_PUSH_SERVICE_ACCOUNT: fake.serviceAccount,
      GMAIL_DAILY_SEND_CAP_PER_WORKSPACE: 100,
      OAUTH_REDIRECT_BASE_URL: 'http://localhost:3000/api/v1/integrations',
      FRONTEND_URL: 'http://frontend.test',
    };
    return (overrides[key] ?? super.get(key)) as Env[K];
  }
}

/**
 * Part 26 — Gmail against a simulated Google (OAuth + PKCE, Pub/Sub OIDC push, Gmail v1):
 * AC-26.1 connect/refresh/revoke/disconnect, AC-26.2 push → history → runs, AC-26.3 watch
 * lifecycle, AC-26.4 actions, AC-26.5 email content never logged, data minimised.
 */
describe('Gmail integration (integration)', () => {
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
  const sync = () => worker.get(GmailSyncService);

  async function connect(user: RegisteredUser = admin, workspace = ws): Promise<URL> {
    const start = await request(server)
      .post(`${integrations(workspace)}/GMAIL/connect`)
      .set(bearer(user.accessToken))
      .expect(201);
    const authorize = new URL(start.body.url);
    const code = fake.issueCode(authorize.searchParams.get('code_challenge')!);
    const done = await request(server)
      .get('/api/v1/integrations/gmail/callback')
      .query({ code, state: authorize.searchParams.get('state')! })
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
      .send({ name: 'gmail' })
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

  const log = {
    key: 'log',
    kind: 'ACTION',
    type: 'util.log',
    config: { message: 'mail {{ trigger.messageId }}' },
  };
  const trigger = (type: string, config: object = {}, conn?: string) => ({
    key: 'trigger',
    kind: 'TRIGGER',
    type,
    config: { connectionId: conn ?? connectionId, ...config },
  });
  const manual = { key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger', config: {} };
  const gmailNode = (key: string, type: string, config: object) => ({
    key,
    kind: 'ACTION',
    type,
    config: { connectionId, ...config },
  });
  const runsOf = (workflowId: string) =>
    prisma.workflowRun.findMany({ where: { workflowId }, orderBy: { createdAt: 'asc' } });
  const push = (overrides: Parameters<FakeGoogle['push']>[0] = {}) => {
    const p = fake.push(overrides);
    return request(server)
      .post('/api/v1/webhooks/gmail')
      .set({ authorization: p.authorization, 'content-type': 'application/json' })
      .send(p.body);
  };
  const settled = (runId: string) =>
    waitFor(
      async () => {
        const r = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });
        return ['SUCCEEDED', 'FAILED'].includes(r.status) ? r : undefined;
      },
      { timeoutMs: 30_000, what: `run ${runId}` },
    );
  async function runManual(nodes: { key: string }[], input: object = {}) {
    const all = [manual, ...nodes];
    const id = await publish(
      all,
      all.slice(1).map((n, i) => ({ from: all[i].key, to: n.key })),
    );
    const res = await request(server)
      .post(`${workflows()}/${id}/runs`)
      .set(auth())
      .send({ input })
      .expect(202);
    const run = await settled(res.body.runId);
    const steps = await prisma.stepRun.findMany({
      where: { runId: run.id },
      orderBy: { sequence: 'asc' },
    });
    return { run, step: (key: string) => steps.find((s) => s.nodeKey === key)! };
  }
  const subscriptionOf = (conn = connectionId) =>
    prisma.providerSubscription.findFirstOrThrow({
      where: { connectionId: conn, provider: 'GMAIL' },
    });

  beforeAll(async () => {
    await fake.start();
    const useFakes = (b: TestingModuleBuilder) =>
      b.overrideProvider(AppConfigService).useClass(GmailTestConfig);
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

  describe('connect (FR-26.1/26.2, AC-26.1)', () => {
    it('uses PKCE, offline access and consent; stores one connection per mailbox', async () => {
      const providers = await request(server)
        .get('/api/v1/integrations/providers')
        .set(auth())
        .expect(200);
      expect(providers.body).toContainEqual({
        key: 'GMAIL',
        configured: true,
        connectionType: 'OAUTH',
      });
      const start = await request(server)
        .post(`${integrations()}/GMAIL/connect`)
        .set(auth())
        .expect(201);
      const authorize = new URL(start.body.url);
      expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
        client_id: fake.clientId,
        redirect_uri: 'http://localhost:3000/api/v1/integrations/gmail/callback',
        response_type: 'code',
        scope:
          'openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send',
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
      });
      const done = await connect();
      expect(done.searchParams.get('status')).toBe('connected');
      connectionId = done.searchParams.get('connectionId')!;
      const connection = await prisma.integrationConnection.findUniqueOrThrow({
        where: { id: connectionId },
      });
      expect(connection).toMatchObject({
        provider: 'GMAIL',
        externalAccountId: fake.sub,
        accountLabel: fake.email,
        metadata: { emailAddress: fake.email },
      });
      const stored = await prisma.integrationCredential.findUniqueOrThrow({
        where: { connectionId },
      });
      expectNoSecrets([stored], [...fake.validAccessTokens, ...fake.validRefreshTokens]);
    });

    it('refuses a grant where the user unticked a Gmail scope', async () => {
      const full = fake.grantedScopes;
      fake.grantedScopes = 'openid email https://www.googleapis.com/auth/gmail.send';
      try {
        const done = await connect();
        expect(done.searchParams.get('reason')).toBe('not_authorized');
      } finally {
        fake.grantedScopes = full;
      }
    });
  });

  describe('push → history → runs (FR-26.5–26.8, AC-26.2)', () => {
    let inboxWorkflow: string;

    it('publishing a Gmail trigger starts a watch on the topic for INBOX', async () => {
      inboxWorkflow = await publish(
        [trigger('gmail.email.received'), log],
        [{ from: 'trigger', to: 'log' }],
      );
      const sub = await waitFor(
        async () =>
          (await prisma.providerSubscription.findFirst({ where: { connectionId } })) ?? undefined,
        { what: 'the Gmail watch' },
      );
      expect(fake.watches.at(-1)).toEqual({ topicName: fake.topic, labelIds: ['INBOX'] });
      expect(sub).toMatchObject({
        provider: 'GMAIL',
        status: 'ACTIVE',
        details: {
          labelIds: ['INBOX'],
          historyId: String(fake.historyId),
          emailAddress: fake.email,
        },
      });
      expect(sub.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    });

    it('a verified push resolves history into one run with the minimised email', async () => {
      const message = fake.receive({
        subject: SUBJECT_CANARY,
        text: `Hi team. ${BODY_CANARY}`,
        attachment: 'screenshot.png',
      });
      const res = await push().expect(202);
      expect(res.body).toMatchObject({ accepted: true, duplicate: false, runs: 0 }); // runs come from the worker
      const run = await waitFor(async () => (await runsOf(inboxWorkflow))[0], {
        timeoutMs: 30_000,
        what: 'the Gmail run',
      });
      const done = await settled(run.id);
      expect(done.status).toBe('SUCCEEDED');
      expect(done.triggerInput).toMatchObject({
        event: 'gmail.email.received',
        messageId: message.id,
        threadId: message.threadId,
        from: 'Ada Lovelace <ada@customer.test>',
        subject: SUBJECT_CANARY,
        textBody: `Hi team. ${BODY_CANARY}`,
        hasAttachments: true,
        attachmentNames: ['screenshot.png'],
        mailbox: fake.email,
      });
      const stored = JSON.stringify(done.triggerInput);
      expect(stored).not.toContain('ATTACHMENT-CONTENT-ID');
      expect(stored).not.toContain('rfcMessageId');
      // The delivery keeps only mailbox + history id.
      const delivery = await prisma.webhookDelivery.findFirstOrThrow({
        where: { provider: 'GMAIL' },
        orderBy: { receivedAt: 'desc' },
      });
      expect(delivery.payload).toMatchObject({
        data: { emailAddress: fake.email, historyId: String(fake.historyId) },
      });
      expect(JSON.stringify(delivery.payload)).not.toContain(BODY_CANARY);
      expect((await subscriptionOf()).details).toMatchObject({ historyId: String(fake.historyId) });
    });

    it('duplicate pushes and repeated or concurrent resolutions never create a second run', async () => {
      const message = fake.receive({ subject: 'Second' });
      const p = fake.push({ messageId: 'dup-1' });
      const send = () =>
        request(server)
          .post('/api/v1/webhooks/gmail')
          .set({ authorization: p.authorization })
          .send(p.body);
      await send().expect(202);
      const dup = await send();
      expect(dup.body.duplicate).toBe(true);
      await waitFor(async () => ((await runsOf(inboxWorkflow)).length === 2 ? true : undefined), {
        what: 'the second run',
      });
      // Rewind the stored history id (as if a resolution was lost) and resolve 3× at once.
      const sub = await subscriptionOf();
      await prisma.providerSubscription.update({
        where: { id: sub.id },
        data: { details: { ...(sub.details as object), historyId: '1000' } },
      });
      await Promise.all([
        sync().resolve(connectionId),
        sync().resolve(connectionId),
        sync().resolve(connectionId),
      ]);
      const runs = await runsOf(inboxWorkflow);
      expect(runs).toHaveLength(2);
      expect(runs.map((r) => (r.triggerInput as { messageId: string }).messageId).sort()).toEqual(
        [...runs.map((r) => (r.triggerInput as { messageId: string }).messageId)].sort(),
      );
      expect(
        runs.some((r) => (r.triggerInput as { messageId: string }).messageId === message.id),
      ).toBe(true);
    });

    it('pages through history; skips mail sent by the mailbox itself', async () => {
      const before = (await runsOf(inboxWorkflow)).length;
      fake.receive({ subject: 'p1' });
      fake.receive({ subject: 'p2' });
      fake.receive({ subject: 'p3' });
      fake.receive({ subject: 'sent by me', from: fake.email, labelIds: ['INBOX', 'SENT'] });
      const r = await sync().resolve(connectionId);
      expect(r).toMatchObject({ gap: false, runs: 3 });
      expect(
        fake.calls
          .filter((c) => c.path.startsWith('/history'))
          .some((c) => c.path.includes('pageToken=')),
      ).toBe(true);
      expect((await runsOf(inboxWorkflow)).length - before).toBe(3);
    });

    it('a label trigger fires for that label only; the watch covers the union of labels', async () => {
      const labelWorkflow = await publish(
        [trigger('gmail.email.labelReceived', { labelId: 'Label_support' }), log],
        [{ from: 'trigger', to: 'log' }],
      );
      await sync().run(ws);
      expect(fake.watches.at(-1)!.labelIds).toEqual(['INBOX', 'Label_support']);
      const inboxBefore = (await runsOf(inboxWorkflow)).length;
      const m = fake.receive({ subject: 'Needs a label', labelIds: ['CATEGORY_UPDATES'] }); // not in INBOX
      fake.addLabel(m.id, 'Label_support');
      await sync().resolve(connectionId);
      const runs = await runsOf(labelWorkflow);
      expect(
        runs.map((r) => (r.triggerInput as { messageId: string; event: string }).messageId),
      ).toEqual([m.id]);
      expect(runs[0].triggerInput).toMatchObject({ event: 'gmail.email.labelReceived' });
      expect((await runsOf(inboxWorkflow)).length).toBe(inboxBefore);
    });

    it('rejects unauthenticated pushes and stores nothing', async () => {
      const count = await prisma.webhookDelivery.count({ where: { provider: 'GMAIL' } });
      await push({ audience: 'https://attacker.test' }).expect(401);
      await push({ email: 'other@evil.iam.gserviceaccount.com' }).expect(401);
      await request(server).post('/api/v1/webhooks/gmail').send(fake.push().body).expect(401);
      expect(await prisma.webhookDelivery.count({ where: { provider: 'GMAIL' } })).toBe(count);
    });

    it('missed history (404) restarts from the current history id without backfill', async () => {
      const before = (await runsOf(inboxWorkflow)).length;
      fake.receive({ subject: 'lost during outage' });
      fake.oldestHistoryId = fake.historyId + 1; // stored id is now too old
      const r = await sync().resolve(connectionId);
      expect(r).toMatchObject({ gap: true, runs: 0 });
      const sub = await subscriptionOf();
      expect(sub.details).toMatchObject({
        historyId: String(fake.historyId),
        gapAt: expect.any(String),
      });
      expect(sub.lastError).toMatch(/history gap/);
      fake.oldestHistoryId = 0;
      fake.receive({ subject: 'after the gap' });
      expect(await sync().resolve(connectionId)).toMatchObject({ runs: 1 });
      expect((await runsOf(inboxWorkflow)).length - before).toBe(1);
    });
  });

  describe('watch lifecycle (FR-26.4, FR-26.10, AC-26.3)', () => {
    it('renews before expiry keeping the history position; recovers an expired watch', async () => {
      const sub = await subscriptionOf();
      const historyId = (sub.details as { historyId: string }).historyId;
      await prisma.providerSubscription.update({
        where: { id: sub.id },
        data: { expiresAt: new Date(Date.now() + DAY) },
      });
      const watches = fake.watches.length;
      await sync().run(ws);
      expect(fake.watches.length).toBe(watches + 1);
      const renewed = await subscriptionOf();
      expect(renewed.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
      expect((renewed.details as { historyId: string }).historyId).toBe(historyId);

      // Expired: re-watch, then resolve what arrived meanwhile.
      fake.receive({ subject: 'while the watch was expired' });
      await prisma.providerSubscription.update({
        where: { id: sub.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      const runsBefore = await prisma.workflowRun.count({
        where: { workspaceId: ws, triggerSource: 'WEBHOOK' },
      });
      await sync().run(ws);
      await waitFor(
        async () =>
          (await prisma.workflowRun.count({
            where: { workspaceId: ws, triggerSource: 'WEBHOOK' },
          })) > runsBefore
            ? true
            : undefined,
        { what: 'catch-up run' },
      );
    });

    it('3 renewal failures flag the connection; the next success clears it', async () => {
      const sub = await subscriptionOf();
      await prisma.providerSubscription.update({
        where: { id: sub.id },
        data: { expiresAt: new Date(Date.now() + DAY) },
      });
      for (let i = 0; i < 3; i++) {
        fake.apiScript.push({ path: '/watch', status: 500, body: {} });
        await sync().run(ws);
      }
      expect(await subscriptionOf()).toMatchObject({ consecutiveFailures: 3, status: 'FAILING' });
      expect(
        await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } }),
      ).toMatchObject({ status: 'NEEDS_ATTENTION', statusReason: 'WATCH_RENEWAL_FAILED' });
      await sync().run(ws);
      expect(await subscriptionOf()).toMatchObject({ consecutiveFailures: 0, status: 'ACTIVE' });
      expect(
        await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } }),
      ).toMatchObject({ status: 'CONNECTED', statusReason: null });
    });

    it('two workspaces on one mailbox: each gets its own runs; the shared watch is not stopped while used', async () => {
      const other = await registerUser(server);
      const otherWs = (
        await prisma.workspaceMember.findFirstOrThrow({ where: { userId: other.id } })
      ).workspaceId;
      const otherConnection = (await connect(other, otherWs)).searchParams.get('connectionId')!;
      const otherWorkflow = await publish(
        [trigger('gmail.email.received', {}, otherConnection), log],
        [{ from: 'trigger', to: 'log' }],
        otherWs,
        other,
      );
      await sync().run(otherWs);
      expect(await prisma.providerSubscription.count({ where: { provider: 'GMAIL' } })).toBe(2);

      const m = fake.receive({ subject: 'for both' });
      await push().expect(202);
      await waitFor(async () => ((await runsOf(otherWorkflow)).length ? true : undefined), {
        timeoutMs: 30_000,
        what: 'run in the second workspace',
      });
      const otherRuns = await runsOf(otherWorkflow);
      expect(
        otherRuns.map((r) => [r.workspaceId, (r.triggerInput as { messageId: string }).messageId]),
      ).toEqual([[otherWs, m.id]]);
      expect(
        await prisma.workflowRun.count({
          where: { workspaceId: ws, triggerInput: { path: ['messageId'], equals: m.id } },
        }),
      ).toBeGreaterThan(0);

      // The other workspace archives its workflow: its subscription goes, the watch stays.
      const stops = fake.stops;
      await request(server)
        .post(`/api/v1/workspaces/${otherWs}/workflows/${otherWorkflow}/archive`)
        .set(bearer(other.accessToken))
        .expect(200);
      await sync().run(otherWs);
      expect(fake.stops).toBe(stops);
      expect(
        await prisma.providerSubscription.count({ where: { connectionId: otherConnection } }),
      ).toBe(0);
    });
  });

  describe('actions (FR-26.9, AC-26.4)', () => {
    let messageId: string;
    beforeAll(() => {
      messageId = fake.receive({
        subject: 'Invoice question',
        from: 'Grace <grace@customer.test>',
        to: `${fake.email}, ops@acme.test`,
      }).id;
    });

    it('send, reply (threaded), get, labels and read state', async () => {
      const { run, step } = await runManual(
        [
          gmailNode('send', 'gmail.sendEmail', {
            to: '{{ trigger.to }}',
            cc: 'boss@acme.test',
            subject: 'Daily report ✓',
            text: 'All green',
            html: '<p>All green</p>',
          }),
          gmailNode('reply', 'gmail.replyToEmail', {
            messageId: '{{ trigger.messageId }}',
            text: 'Thanks, looking into it',
            replyAll: true,
          }),
          gmailNode('get', 'gmail.getEmail', { messageId: '{{ trigger.messageId }}' }),
          gmailNode('label', 'gmail.addLabel', {
            messageId: '{{ trigger.messageId }}',
            labelId: 'Label_support',
          }),
          gmailNode('unlabel', 'gmail.removeLabel', {
            messageId: '{{ trigger.messageId }}',
            labelId: 'Label_support',
          }),
          gmailNode('read', 'gmail.markAsRead', { messageId: '{{ trigger.messageId }}' }),
          gmailNode('unread', 'gmail.markAsUnread', { messageId: '{{ trigger.messageId }}' }),
        ],
        { to: 'customer@client.test', messageId },
      );
      expect(run.status).toBe('SUCCEEDED');
      const [report, reply] = fake.sent.slice(-2);
      expect(report.raw).toContain(`From: ${fake.email}\r\n`);
      expect(report.raw).toContain('To: customer@client.test\r\n');
      expect(report.raw).toContain('Cc: boss@acme.test\r\n');
      expect(report.raw).toContain(
        `Subject: =?UTF-8?B?${Buffer.from('Daily report ✓').toString('base64')}?=`,
      );
      expect(report.raw).toContain('multipart/alternative');
      expect(reply.threadId).toBe(`thread-${messageId}`);
      expect(reply.raw).toContain('To: Grace <grace@customer.test>');
      expect(reply.raw).toContain('Cc: ops@acme.test'); // reply-all, without our own mailbox
      expect(reply.raw).not.toMatch(/Cc:.*support@acme\.test/);
      expect(reply.raw).toContain('Subject: Re: Invoice question');
      expect(reply.raw).toContain(`In-Reply-To: <${messageId}@mail.customer.test>`);
      expect(reply.raw).toContain(`References: <${messageId}@mail.customer.test>`);
      expect(step('get').sanitizedOutput).toMatchObject({
        messageId,
        subject: 'Invoice question',
        from: 'Grace <grace@customer.test>',
      });
      expect(step('read').sanitizedOutput).toMatchObject({ messageId });
      expect(fake.messages.get(messageId)!.labelIds).toContain('UNREAD');
      expect(fake.messages.get(messageId)!.labelIds).not.toContain('Label_support');
    });

    it('a rendered header injection never sends', async () => {
      const sent = fake.sent.length;
      const { run } = await runManual(
        [gmailNode('send', 'gmail.sendEmail', { to: '{{ trigger.to }}', subject: 's', text: 't' })],
        { to: 'a@b.test\r\nBcc: everyone@victim.test' },
      );
      expect(run).toMatchObject({ status: 'FAILED', lastErrorCategory: 'VALIDATION' });
      expect(fake.sent.length).toBe(sent);
    });

    it('send 5xx is UNCERTAIN_OUTCOME (one attempt); label 5xx is retried', async () => {
      fake.apiScript.push({ path: '/messages/send', status: 500, body: {} });
      const sendCalls = fake.calls.filter((c) => c.path === '/messages/send').length;
      const failed = await runManual([
        gmailNode('send', 'gmail.sendEmail', { to: 'x@y.test', subject: 's', text: 't' }),
      ]);
      expect(failed.run).toMatchObject({
        status: 'FAILED',
        lastErrorCategory: 'UNCERTAIN_OUTCOME',
      });
      expect(fake.calls.filter((c) => c.path === '/messages/send').length - sendCalls).toBe(1);
      fake.apiScript.push({ path: `/messages/${messageId}/modify`, status: 500, body: {} });
      const retried = await runManual([
        gmailNode('l', 'gmail.addLabel', { messageId, labelId: 'Label_support' }),
      ]);
      expect(retried.run.status).toBe('SUCCEEDED');
    });

    it('enforces the daily send cap per workspace', async () => {
      const redis = api.get<Redis>(REDIS_CLIENT);
      await redis.set(`ff:gmail-sends:${ws}:${new Date().toISOString().slice(0, 10)}`, '100');
      const sent = fake.sent.length;
      const { run } = await runManual([
        gmailNode('send', 'gmail.sendEmail', { to: 'x@y.test', subject: 's', text: 't' }),
      ]);
      expect(run).toMatchObject({ status: 'FAILED', lastErrorCategory: 'VALIDATION' });
      expect(run.errorMessage).toMatch(/daily Gmail send limit/);
      expect(fake.sent.length).toBe(sent);
      await redis.del(`ff:gmail-sends:${ws}:${new Date().toISOString().slice(0, 10)}`);
    });
  });

  describe('pickers, isolation, revocation, disconnect', () => {
    it('lists labels; another workspace cannot use the connection', async () => {
      const labels = await request(server)
        .get(`${integrations()}/${connectionId}/gmail/labels`)
        .set(auth())
        .expect(200);
      expect(labels.body).toEqual([
        { id: 'INBOX', name: 'INBOX', type: 'system' },
        { id: 'Label_support', name: 'support', type: 'user' },
      ]);
      const other = await registerUser(server);
      const otherWs = (
        await prisma.workspaceMember.findFirstOrThrow({ where: { userId: other.id } })
      ).workspaceId;
      await request(server)
        .get(`${integrations(otherWs)}/${connectionId}/gmail/labels`)
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
        nodes: [manual, gmailNode('g', 'gmail.getEmail', { messageId: 'abc' })],
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

    it('a revoked grant marks TOKEN_REVOKED; reconnecting heals it', async () => {
      await prisma.integrationCredential.update({
        where: { connectionId },
        data: { accessTokenExpiresAt: new Date(Date.now() - 1_000) },
      });
      fake.tokenScript.push({ status: 400, body: { error: 'invalid_grant' } });
      const { run } = await runManual([gmailNode('g', 'gmail.getEmail', { messageId: 'msg0001' })]);
      expect(run).toMatchObject({ status: 'FAILED', lastErrorCategory: 'PROVIDER_AUTH' });
      expect(
        await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } }),
      ).toMatchObject({ status: 'NEEDS_ATTENTION', statusReason: 'TOKEN_REVOKED' });
      expect((await connect()).searchParams.get('connectionId')).toBe(connectionId);
      expect(
        await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } }),
      ).toMatchObject({ status: 'CONNECTED', statusReason: null });
    });

    it('disconnect stops the watch (no other user of the mailbox), revokes and deletes the tokens', async () => {
      const stops = fake.stops;
      const refresh = (
        await prisma.integrationCredential.findUniqueOrThrow({ where: { connectionId } })
      ).id;
      expect(refresh).toBeTruthy();
      await request(server).delete(`${integrations()}/${connectionId}`).set(auth()).expect(204);
      expect(fake.stops).toBe(stops + 1);
      expect(fake.revoked.length).toBeGreaterThan(0);
      expect(fake.validRefreshTokens.has(fake.revoked.at(-1)!)).toBe(true); // the refresh token was revoked
      expect(await prisma.integrationCredential.count({ where: { connectionId } })).toBe(0);
    });

    it('email content and tokens never appear in logs (AC-26.5)', () => {
      expectNoSecrets(logs, [
        BODY_CANARY,
        SUBJECT_CANARY,
        fake.clientSecret,
        ...fake.validAccessTokens,
        ...fake.validRefreshTokens,
      ]);
    });
  });
});
