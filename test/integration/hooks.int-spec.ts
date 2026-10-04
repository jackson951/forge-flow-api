import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { App } from 'supertest/types';
import { EgressClient } from '../../src/infrastructure/egress/egress-client';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RunQueue } from '../../src/infrastructure/queue/run-queue.service';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { captureLogs, expectNoSecrets } from '../support/canaries';
import { createTestApp } from '../support/create-app';
import { createTestWorker, waitFor } from '../support/create-worker';
import { truncateAll } from '../support/test-database';
import { TestNodeControl } from '../support/test-node-types';

const HOST = 'api.flowforge-test.example';
// Assembled at runtime: never a secret-shaped literal in the source.
const SENDER_SECRET = ['sender', 'chosen', 'secret', 'value', '77aa'].join('-');

const trigger = (config: object) => ({
  key: 'trigger',
  kind: 'TRIGGER',
  type: 'webhook.received',
  config,
});
const log = (message = 'got {{ trigger.body.event }}') => ({
  key: 'log',
  kind: 'ACTION',
  type: 'util.log',
  config: { message },
});

/**
 * Part 24, slice 2 — generic inbound webhooks (AC-24.6, AC-24.8, AC-24.7 Scenario 4) on the
 * real API, worker, Postgres and Redis.
 */
describe('Generic webhooks (integration)', () => {
  let api: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let worker: TestingModule;
  let user: RegisteredUser;
  let ws: string;
  let service: Server;
  let serviceBase: string;
  const logs = captureLogs();

  const auth = () => bearer(user.accessToken);
  const workflows = () => `/api/v1/workspaces/${ws}/workflows`;
  const hookAdmin = (id: string) => `${workflows()}/${id}/webhook`;

  async function create(definition: object, publish = true): Promise<string> {
    const wf = await request(server)
      .post(workflows())
      .set(auth())
      .send({ name: 'hook' })
      .expect(201);
    const draft = await request(server)
      .put(`${workflows()}/${wf.body.id}/draft`)
      .set(auth())
      .send({ expectedRevision: 0, definition })
      .expect(200);
    expect(draft.body.issues).toEqual([]);
    if (publish) {
      await request(server)
        .post(`${workflows()}/${wf.body.id}/publish`)
        .set(auth())
        .send({ expectedRevision: 1 })
        .expect(201);
    }
    return wf.body.id;
  }

  /** trigger → log, published; returns ids, the URL path and the secret (shown once). */
  async function hook(config: object = {}, nodes: object[] = [log()]) {
    const keys = nodes.map((n) => (n as { key: string }).key);
    const id = await create({
      schemaVersion: 1,
      nodes: [trigger(config), ...nodes],
      edges: keys.map((key, i) => ({ from: i === 0 ? 'trigger' : keys[i - 1], to: key })),
    });
    const details = await request(server).get(hookAdmin(id)).set(auth()).expect(200);
    return {
      id,
      path: details.body.path as string,
      secret: details.body.secret as string,
      details: details.body,
    };
  }

  const send = (
    path: string,
    body: string | object = { event: 'ping' },
    headers: Record<string, string> = {},
  ) =>
    request(server)
      .post(path)
      .set({ 'content-type': 'application/json', ...headers })
      .send(typeof body === 'string' ? body : JSON.stringify(body));

  const runsOf = (workflowId: string) =>
    prisma.workflowRun.findMany({ where: { workflowId }, orderBy: { createdAt: 'asc' } });
  const settled = (runId: string) =>
    waitFor(
      async () => {
        const r = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });
        return ['SUCCEEDED', 'FAILED'].includes(r.status) ? r : undefined;
      },
      { timeoutMs: 30_000, what: `run ${runId}` },
    );
  const deliveriesOf = (workflowId: string) =>
    prisma.webhookDelivery.findMany({ where: { workflowId }, orderBy: { receivedAt: 'asc' } });

  beforeAll(async () => {
    service = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            failures: JSON.parse(Buffer.concat(chunks).toString() || '{}').failures ?? 0,
          }),
        );
      });
    });
    await new Promise<void>((r) => service.listen(0, '127.0.0.1', r));
    const port = (service.address() as AddressInfo).port;
    serviceBase = `http://${HOST}:${port}`;

    api = await createTestApp();
    server = api.getHttpServer();
    prisma = api.get(PrismaService);
    worker = await createTestWorker(new TestNodeControl());
    worker.get(EgressClient).allowForTests('127.0.0.1', port, HOST);
    await truncateAll(prisma);
    user = await registerUser(server);
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: user.id } }))
      .workspaceId;
  });

  afterAll(async () => {
    await worker?.close();
    await api.get(RunQueue).queue.obliterate({ force: true });
    await api.close();
    await new Promise((r) => service.close(r));
    jest.restoreAllMocks();
  });

  describe('endpoint lifecycle (FR-24.7)', () => {
    it('publishing provisions an unguessable URL; the secret is shown once', async () => {
      const { id, path, secret, details } = await hook();
      expect(details).toMatchObject({
        provisioned: true,
        active: true,
        verificationMode: 'token',
        url: expect.stringMatching(
          /^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/webhooks\/hooks\/[A-Za-z0-9_-]{22}$/,
        ),
      });
      expect(path).toMatch(/^\/api\/v1\/webhooks\/hooks\/[A-Za-z0-9_-]{22}$/);
      expect(secret).toHaveLength(43);
      const again = await request(server).get(hookAdmin(id)).set(auth()).expect(200);
      expect(again.body.secret).toBeUndefined();
      expect(again.body.secretHint).toBe(`…${secret.slice(-4)}`);
      // Only a hash of the hook id is stored in clear.
      const row = await prisma.workflowWebhook.findUniqueOrThrow({ where: { workflowId: id } });
      expect(JSON.stringify(row)).not.toContain(path.split('/').pop());
    });

    it('unknown, archived and no-longer-webhook workflows answer 404; the URL survives versions', async () => {
      const { id, path, secret } = await hook();
      const token = { 'x-flowforge-token': secret };
      await send('/api/v1/webhooks/hooks/AAAAAAAAAAAAAAAAAAAAAA', {}, token).expect(404);
      await request(server).post(`${workflows()}/${id}/archive`).set(auth()).expect(200);
      const archived = await send(path, {}, token).expect(404);
      expect(archived.body).toEqual({ statusCode: 404, message: 'Not found' });
      await request(server).post(`${workflows()}/${id}/unarchive`).set(auth()).expect(200);
      await send(path, {}, token).expect(202);

      // A new version with another trigger: inactive; switching back reuses the same URL.
      const current = await request(server).get(`${workflows()}/${id}`).set(auth());
      const manual = {
        schemaVersion: 1,
        nodes: [{ key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger', config: {} }, log('x')],
        edges: [{ from: 'trigger', to: 'log' }],
      };
      const d1 = await request(server)
        .put(`${workflows()}/${id}/draft`)
        .set(auth())
        .send({ expectedRevision: current.body.draftRevision, definition: manual })
        .expect(200);
      await request(server)
        .post(`${workflows()}/${id}/publish`)
        .set(auth())
        .send({ expectedRevision: d1.body.draftRevision })
        .expect(201);
      await send(path, {}, token).expect(404);
      const back = {
        schemaVersion: 1,
        nodes: [trigger({}), log('y')],
        edges: [{ from: 'trigger', to: 'log' }],
      };
      const d2 = await request(server)
        .put(`${workflows()}/${id}/draft`)
        .set(auth())
        .send({ expectedRevision: d1.body.draftRevision, definition: back })
        .expect(200);
      await request(server)
        .post(`${workflows()}/${id}/publish`)
        .set(auth())
        .send({ expectedRevision: d2.body.draftRevision })
        .expect(201);
      await send(path, {}, token).expect(202);
    });

    it('acknowledges fast and runs asynchronously through the queue to SUCCEEDED', async () => {
      const { id, path, secret } = await hook();
      const started = Date.now();
      const res = await send(
        path,
        { event: 'order.paid' },
        { 'x-flowforge-token': secret, 'x-request-id': 'req-1' },
      ).expect(202);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(res.body).toEqual({
        accepted: true,
        deliveryId: expect.any(String),
        runId: expect.any(String),
      });
      const run = await settled(res.body.runId);
      expect(run).toMatchObject({ status: 'SUCCEEDED', triggerSource: 'WEBHOOK', workflowId: id });
      expect(run.triggerInput).toMatchObject({
        method: 'POST',
        body: { event: 'order.paid' },
        contentType: 'application/json',
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
        deliveryId: res.body.deliveryId,
        receivedAt: expect.any(String),
        sourceIp: expect.any(String),
      });
      expect((run.triggerInput as { headers: object }).headers).not.toHaveProperty(
        'x-flowforge-token',
      );
      const steps = await prisma.stepRun.findMany({
        where: { runId: run.id },
        orderBy: { sequence: 'asc' },
      });
      expect(steps[1].sanitizedOutput).toEqual({ message: 'got order.paid' });
    });
  });

  describe('verification (FR-24.8, AC-24.6)', () => {
    it('rejects a wrong token with a generic 401 and logs a REJECTED delivery without payload', async () => {
      const { id, path } = await hook();
      const res = await send(path, { secret: 'payload' }, { 'x-flowforge-token': 'wrong' }).expect(
        401,
      );
      expect(res.body).toEqual({ statusCode: 401, message: 'Unauthorized' });
      const [delivery] = await deliveriesOf(id);
      expect(delivery).toMatchObject({
        status: 'REJECTED',
        reason: 'token mismatch',
        payload: null,
      });
      expect(await runsOf(id)).toEqual([]);
    });

    it('bearer token and basic authentication', async () => {
      const b = await hook({ verification: { mode: 'token', location: 'bearer' } });
      await send(b.path, {}, { authorization: `Bearer ${b.secret}` }).expect(202);
      await send(b.path, {}, { authorization: 'Bearer nope' }).expect(401);
      const basic = await hook({ verification: { mode: 'basic', username: 'sender' } });
      const creds = Buffer.from(`sender:${basic.secret}`).toString('base64');
      await send(basic.path, {}, { authorization: `Basic ${creds}` }).expect(202);
      await send(
        basic.path,
        {},
        { authorization: `Basic ${Buffer.from('sender:x').toString('base64')}` },
      ).expect(401);
    });

    it('HMAC over the exact raw bytes, with a prefix (GitHub style)', async () => {
      const { path, secret } = await hook({
        verification: { mode: 'hmac', headerName: 'X-Hub-Signature-256', prefix: 'sha256=' },
      });
      const raw = '{"event":"push",  "spaces":"kept"}';
      const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
      await send(path, raw, { 'x-hub-signature-256': sig }).expect(202);
      // Same JSON, different bytes: the signature no longer matches.
      await send(path, '{"event":"push","spaces":"kept"}', { 'x-hub-signature-256': sig }).expect(
        401,
      );
    });

    it('timestamped HMAC inside the replay window only (Slack style)', async () => {
      const { path, secret } = await hook({
        verification: {
          mode: 'hmac',
          headerName: 'X-Slack-Signature',
          prefix: 'v0=',
          timestamp: { headerName: 'X-Slack-Request-Timestamp', format: 'v0:{timestamp}:{body}' },
        },
      });
      const raw = '{"event":"message"}';
      const signed = (ts: number) => ({
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`,
      });
      const now = Math.floor(Date.now() / 1_000);
      await send(path, raw, signed(now)).expect(202);
      await send(path, raw, signed(now - 600)).expect(401); // replayed old request
    });

    it('IP allow-list on top of the token', async () => {
      const blocked = await hook({ ipAllowList: ['10.0.0.0/8'] });
      await send(blocked.path, {}, { 'x-flowforge-token': blocked.secret }).expect(401);
      const allowed = await hook({ ipAllowList: ['127.0.0.1', '::1'] });
      await send(allowed.path, {}, { 'x-flowforge-token': allowed.secret }).expect(202);
    });

    it('unverified mode needs the explicit acknowledgement', async () => {
      const { path } = await hook({ verification: { mode: 'none', acknowledgeUnverified: true } });
      await send(path, {}).expect(202);
    });
  });

  describe('rotation with grace (FR-24.9)', () => {
    it('the previous secret works during the grace period, not after an immediate rotation', async () => {
      const { id, path, secret } = await hook();
      const rotated = await request(server)
        .post(`${hookAdmin(id)}/rotate-secret`)
        .set(auth())
        .send({})
        .expect(200);
      expect(rotated.body.secret).toHaveLength(43);
      expect(rotated.body.previousSecretExpiresAt).toBeTruthy();
      await send(path, {}, { 'x-flowforge-token': secret }).expect(202);
      await send(path, {}, { 'x-flowforge-token': rotated.body.secret }).expect(202);

      // The sender's own secret, no grace: only it is accepted now.
      const own = await request(server)
        .post(`${hookAdmin(id)}/rotate-secret`)
        .set(auth())
        .send({ secret: SENDER_SECRET, graceHours: 0 })
        .expect(200);
      expect(own.body.secret).toBeUndefined();
      await send(path, {}, { 'x-flowforge-token': rotated.body.secret }).expect(401);
      await send(path, {}, { 'x-flowforge-token': SENDER_SECRET }).expect(202);
    });

    it('URL rotation keeps the old URL working during the grace period', async () => {
      const { id, path, secret } = await hook();
      const token = { 'x-flowforge-token': secret };
      const next = await request(server)
        .post(`${hookAdmin(id)}/rotate-url`)
        .set(auth())
        .send({})
        .expect(200);
      expect(next.body.path).not.toBe(path);
      await send(path, {}, token).expect(202);
      await send(next.body.path, {}, token).expect(202);
      const third = await request(server)
        .post(`${hookAdmin(id)}/rotate-url`)
        .set(auth())
        .send({ graceHours: 0 })
        .expect(200);
      await send(path, {}, token).expect(404);
      await send(next.body.path, {}, token).expect(404);
      await send(third.body.path, {}, token).expect(202);
    });
  });

  describe('payloads, dedup, filters, limits, responses (FR-24.10–24.14)', () => {
    it('accepts form, text and XML; rejects malformed JSON (400) and oversized bodies (413)', async () => {
      const { id, path, secret } = await hook({}, [log('{{ trigger.contentType }}')]);
      const token = { 'x-flowforge-token': secret };
      const form = await request(server)
        .post(path)
        .set({ ...token, 'content-type': 'application/x-www-form-urlencoded' })
        .send('a=1&b=two')
        .expect(202);
      const text = await request(server)
        .post(path)
        .set({ ...token, 'content-type': 'text/plain' })
        .send('hello')
        .expect(202);
      const xml = await request(server)
        .post(path)
        .set({ ...token, 'content-type': 'application/xml' })
        .send('<a>1</a>')
        .expect(202);
      const inputs = await Promise.all(
        [form, text, xml].map(
          async (r) =>
            (await prisma.workflowRun.findUniqueOrThrow({ where: { id: r.body.runId } }))
              .triggerInput,
        ),
      );
      expect(inputs[0]).toMatchObject({
        body: { a: '1', b: 'two' },
        contentType: 'application/x-www-form-urlencoded',
      });
      expect(inputs[1]).toMatchObject({ body: 'hello', contentType: 'text/plain' });
      expect(inputs[2]).toMatchObject({
        body: null,
        rawText: '<a>1</a>',
        contentType: 'application/xml',
      });

      await send(path, '{not json', token).expect(400);
      await send(path, JSON.stringify({ big: 'x'.repeat(300_000) }), token).expect(413);
      const statuses = (await deliveriesOf(id)).map((d) => d.status);
      expect(statuses.filter((s) => s === 'PROCESSED')).toHaveLength(3);
      expect(statuses).toContain('REJECTED'); // malformed JSON
    });

    it('deduplicates by header, also for concurrent deliveries: one run', async () => {
      const { id, path, secret } = await hook({
        deduplication: { source: 'header', header: 'Idempotency-Key' },
      });
      const headers = { 'x-flowforge-token': secret, 'idempotency-key': 'order-1' };
      const results = await Promise.all(
        Array.from({ length: 5 }, () => send(path, { n: 1 }, headers)),
      );
      expect(results.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
      const runIds = new Set(results.map((r) => r.body.runId));
      expect(runIds.size).toBe(1);
      expect(results.filter((r) => r.body.duplicate)).toHaveLength(4);
      expect(await runsOf(id)).toHaveLength(1);
      const [delivery] = await deliveriesOf(id);
      expect(delivery).toMatchObject({ status: 'PROCESSED', duplicateCount: 4 });
      // A different key is a new delivery.
      await send(path, { n: 2 }, { ...headers, 'idempotency-key': 'order-2' }).expect(202);
      expect(await runsOf(id)).toHaveLength(2);
    });

    it('deduplicates by a JSON path in the body', async () => {
      const { id, path, secret } = await hook({
        deduplication: { source: 'body', path: 'event.id' },
      });
      const token = { 'x-flowforge-token': secret };
      await send(path, { event: { id: 'evt_9' } }, token).expect(202);
      const dup = await send(path, { event: { id: 'evt_9' }, retry: true }, token).expect(202);
      expect(dup.body.duplicate).toBe(true);
      expect(await runsOf(id)).toHaveLength(1);
    });

    it('a filter keeps non-matching deliveries out of run history (IGNORED)', async () => {
      const filter = {
        all: [{ left: { ref: 'trigger.body.type' }, operator: 'equals', right: { value: 'paid' } }],
      };
      const { id, path, secret } = await hook({ filter });
      const token = { 'x-flowforge-token': secret };
      const ignored = await send(path, { type: 'refunded' }, token).expect(202);
      expect(ignored.body.runId).toBeUndefined();
      await send(path, { type: 'paid' }, token).expect(202);
      expect(await runsOf(id)).toHaveLength(1);
      expect((await deliveriesOf(id)).map((d) => [d.status, d.reason])).toEqual([
        ['IGNORED', 'filter did not match'],
        ['PROCESSED', null],
      ]);
    });

    it('per-hook rate limit answers 429 with Retry-After', async () => {
      const { path, secret } = await hook({ rateLimitPerMinute: 2 });
      const token = { 'x-flowforge-token': secret };
      await send(path, {}, token).expect(202);
      await send(path, {}, token).expect(202);
      const limited = await send(path, {}, token).expect(429);
      expect(limited.headers['retry-after']).toBe('60');
    });

    it('custom responses, challenge echo and method checks', async () => {
      const custom = await hook({ response: { status: 200, body: { ok: 'thanks' } } });
      const res = await send(custom.path, {}, { 'x-flowforge-token': custom.secret }).expect(200);
      expect(res.body).toEqual({ ok: 'thanks' });
      const empty = await hook({ response: { status: 204 } });
      await send(empty.path, {}, { 'x-flowforge-token': empty.secret }).expect(204);

      const challenge = await hook({
        methods: ['POST', 'GET'],
        challenge: { queryParam: 'challenge' },
      });
      const echo = await request(server).get(`${challenge.path}?challenge=abc123`).expect(200);
      expect(echo.text).toBe('abc123');
      expect(echo.headers['content-type']).toMatch(/^text\/plain/);
      await request(server).put(challenge.path).send({}).expect(405);
      await request(server).delete(challenge.path).expect(404); // not routed at all
    });
  });

  describe('delivery log, replay, test capture (FR-24.15, AC-24.8)', () => {
    it('lists deliveries with status and reason, never secrets; replays a stored delivery', async () => {
      const { id, path, secret } = await hook();
      await send(path, { event: 'one' }, { 'x-flowforge-token': secret }).expect(202);
      await send(path, { event: 'two' }, { 'x-flowforge-token': 'bad-token' }).expect(401);
      const log1 = await request(server)
        .get(`${hookAdmin(id)}/deliveries?limit=1`)
        .set(auth())
        .expect(200);
      expect(log1.body.items).toHaveLength(1);
      expect(log1.body.nextCursor).toBeTruthy();
      const log2 = await request(server)
        .get(`${hookAdmin(id)}/deliveries?limit=1&cursor=${log1.body.nextCursor}`)
        .set(auth())
        .expect(200);
      const [rejected, accepted] = [log1.body.items[0], log2.body.items[0]];
      expect(rejected).toMatchObject({ status: 'REJECTED', reason: 'token mismatch', run: null });
      expect(accepted).toMatchObject({
        status: 'PROCESSED',
        run: { id: expect.any(String) },
        duplicateCount: 0,
      });
      expectNoSecrets([log1.body, log2.body], [secret, 'bad-token']);

      const replay = await request(server)
        .post(`${hookAdmin(id)}/deliveries/${accepted.id}/replay`)
        .set(auth())
        .expect(202);
      const run = await settled(replay.body.runId);
      expect(run).toMatchObject({ status: 'SUCCEEDED' });
      expect(run.triggerInput).toMatchObject({
        body: { event: 'one' },
        replayOfDeliveryId: accepted.id,
      });
      await request(server)
        .post(`${hookAdmin(id)}/deliveries/${rejected.id}/replay`)
        .set(auth())
        .expect(409);
    });

    it('captures one test event for an unpublished workflow', async () => {
      const id = await create(
        { schemaVersion: 1, nodes: [trigger({}), log()], edges: [{ from: 'trigger', to: 'log' }] },
        false,
      );
      const listen = await request(server)
        .post(`${hookAdmin(id)}/listen`)
        .set(auth())
        .expect(200);
      expect(listen.body).toMatchObject({
        path: expect.stringMatching(/\/webhooks\/hooks\//),
        expiresAt: expect.any(String),
      });
      const captured = await send(listen.body.path, { sample: { orderId: 42 } }).expect(202);
      expect(captured.body).toEqual({ accepted: true, captured: true });
      const event = await request(server)
        .get(`${hookAdmin(id)}/listen`)
        .set(auth())
        .expect(200);
      expect(event.body).toMatchObject({
        listening: false,
        event: { body: { sample: { orderId: 42 } }, method: 'POST' },
      });
      // Capture is one-shot; the workflow is not live, so the URL does not exist otherwise.
      await send(listen.body.path, {}).expect(404);
      expect(await runsOf(id)).toEqual([]);
    });

    it('another workspace cannot see or manage the webhook', async () => {
      const { id } = await hook();
      const other = await registerUser(server);
      const otherWs = (
        await prisma.workspaceMember.findFirstOrThrow({ where: { userId: other.id } })
      ).workspaceId;
      const base = `/api/v1/workspaces/${otherWs}/workflows/${id}/webhook`;
      await request(server).get(base).set(bearer(other.accessToken)).expect(404);
      await request(server).get(`${base}/deliveries`).set(bearer(other.accessToken)).expect(404);
      await request(server)
        .post(`${base}/rotate-secret`)
        .set(bearer(other.accessToken))
        .send({})
        .expect(404);
    });
  });

  describe('Scenario 4: webhook → HTTP request → condition → log (AC-24.7)', () => {
    it('runs end to end through queue, worker and engine', async () => {
      const id = await create({
        schemaVersion: 1,
        nodes: [
          trigger({ deduplication: { source: 'body', path: 'checkId' } }),
          {
            key: 'fetch',
            kind: 'ACTION',
            type: 'http.request',
            config: {
              method: 'POST',
              url: `${serviceBase}/check`,
              body: { type: 'json', value: { failures: { ref: 'trigger.body.failures' } } },
            },
          },
          {
            key: 'check',
            kind: 'CONDITION',
            type: 'condition',
            config: {
              all: [
                {
                  left: { ref: 'steps.fetch.output.body.failures' },
                  operator: 'greaterThan',
                  right: { value: 0 },
                },
              ],
            },
          },
          log('{{ steps.fetch.output.body.failures }} failures'),
        ],
        edges: [
          { from: 'trigger', to: 'fetch' },
          { from: 'fetch', to: 'check' },
          { from: 'check', to: 'log', branch: 'true' },
        ],
      });
      const details = await request(server).get(hookAdmin(id)).set(auth()).expect(200);
      const { path, secret } = details.body as { path: string; secret: string };

      const res = await send(
        path,
        { checkId: 'c-1', failures: 3 },
        { 'x-flowforge-token': secret },
      ).expect(202);
      const run = await settled(res.body.runId);
      expect(run.status).toBe('SUCCEEDED');
      const steps = await prisma.stepRun.findMany({
        where: { runId: run.id },
        orderBy: { sequence: 'asc' },
      });
      expect(steps.map((s) => [s.nodeKey, s.status])).toEqual([
        ['trigger', 'SUCCEEDED'],
        ['fetch', 'SUCCEEDED'],
        ['check', 'SUCCEEDED'],
        ['log', 'SUCCEEDED'],
      ]);
      expect(steps[3].sanitizedOutput).toEqual({ message: '3 failures' });
      expectNoSecrets([steps, logs], [secret]);
    });
  });
});
