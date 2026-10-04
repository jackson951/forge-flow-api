import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule } from '@nestjs/testing';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
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
import { createRun, createWorkflow } from '../support/factories';
import { truncateAll } from '../support/test-database';
import { TestNodeControl } from '../support/test-node-types';

// Assembled at runtime: not a real secret format, never a literal in the source.
const TOKEN = ['ff', 'test', 'bearer', 'canary', '7d1e'].join('-');
const ROTATED = ['ff', 'test', 'rotated', 'canary', '42aa'].join('-');
const API_KEY = ['ff', 'test', 'apikey', 'canary', '9b0c'].join('-');
const HOST = 'api.flowforge-test.example';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/**
 * Part 24, slice 1 — outbound HTTP against a controlled local test service (AC-24.1–24.5):
 * methods, templating, every auth type, normalised output, error classification and
 * retries, SSRF on redirects, connection host allow-list, secrets never stored or logged,
 * and connections of another workspace refused at publish and at execution.
 */
describe('HTTP action and connections (integration)', () => {
  let api: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let worker: TestingModule;
  let user: RegisteredUser;
  let ws: string;
  let service: Server;
  let base: string;
  const seen: Seen[] = [];
  let respond: (req: Seen, res: ServerResponse) => void;
  const logs = captureLogs();

  const auth = () => bearer(user.accessToken);
  const integrations = () => `/api/v1/workspaces/${ws}/integrations`;
  const workflows = () => `/api/v1/workspaces/${ws}/workflows`;

  /** Default service behaviour: JSON echo of what was received, 401 without the token. */
  const echo = (req: Seen, res: ServerResponse) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('set-cookie', 'sid=should-not-be-stored');
    res.end(JSON.stringify({ method: req.method, url: req.url, body: req.body }));
  };

  async function connect(credentials: object, extra: object = {}): Promise<string> {
    const res = await request(server)
      .post(`${integrations()}/http`)
      .set(auth())
      .send({ name: 'Test service', credentials, ...extra })
      .expect(201);
    return res.body.id;
  }

  async function publish(nodes: object[], edges: object[]): Promise<string> {
    const wf = await request(server)
      .post(workflows())
      .set(auth())
      .send({ name: 'http' })
      .expect(201);
    const draft = await request(server)
      .put(`${workflows()}/${wf.body.id}/draft`)
      .set(auth())
      .send({ expectedRevision: 0, definition: { schemaVersion: 1, nodes, edges } })
      .expect(200);
    expect(draft.body.issues).toEqual([]);
    await request(server)
      .post(`${workflows()}/${wf.body.id}/publish`)
      .set(auth())
      .send({ expectedRevision: 1 })
      .expect(201);
    return wf.body.id;
  }

  const trigger = { key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger', config: {} };
  const call = (config: object) => ({ key: 'call', kind: 'ACTION', type: 'http.request', config });

  /** trigger → call; returns the finished run and its steps. */
  async function runCall(config: object, input: object = {}) {
    const id = await publish([trigger, call(config)], [{ from: 'trigger', to: 'call' }]);
    return start(id, input);
  }

  async function start(workflowId: string, input: object = {}) {
    const res = await request(server)
      .post(`${workflows()}/${workflowId}/runs`)
      .set(auth())
      .send({ input })
      .expect(202);
    return settled(res.body.runId);
  }

  async function settled(runId: string) {
    const run = await waitFor(
      async () => {
        const r = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });
        return ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(r.status) ? r : undefined;
      },
      { timeoutMs: 30_000, what: `run ${runId}` },
    );
    const steps = await prisma.stepRun.findMany({ where: { runId }, orderBy: { sequence: 'asc' } });
    return { run, steps, step: (key: string) => steps.find((s) => s.nodeKey === key)! };
  }

  beforeAll(async () => {
    service = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const entry = {
          method: req.method!,
          url: req.url!,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        };
        seen.push(entry);
        respond(entry, res);
      });
    });
    await new Promise<void>((r) => service.listen(0, '127.0.0.1', r));
    const port = (service.address() as AddressInfo).port;
    // A public-looking name, answered by the test resolver: static checks see a normal host.
    base = `http://${HOST}:${port}`;

    api = await createTestApp();
    server = api.getHttpServer();
    prisma = api.get(PrismaService);
    worker = await createTestWorker(new TestNodeControl());
    // The test service — and only it — is reachable despite being on loopback.
    api.get(EgressClient).allowForTests('127.0.0.1', port, HOST);
    worker.get(EgressClient).allowForTests('127.0.0.1', port, HOST);

    await truncateAll(prisma);
    user = await registerUser(server);
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: user.id } }))
      .workspaceId;
  });

  beforeEach(() => {
    seen.length = 0;
    respond = echo;
  });

  afterAll(async () => {
    await worker?.close();
    await api.get(RunQueue).queue.obliterate({ force: true });
    await api.close();
    await new Promise((r) => service.close(r));
    jest.restoreAllMocks();
  });

  describe('connections (FR-24.4)', () => {
    it('creates a connection whose secrets are write-only', async () => {
      const id = await connect(
        { authType: 'bearer', token: TOKEN },
        { baseUrl: `${base}/v1`, allowedHosts: [] },
      );
      const list = await request(server).get(integrations()).set(auth()).expect(200);
      const created = list.body.find((c: { id: string }) => c.id === id);
      expect(created).toMatchObject({
        provider: 'HTTP',
        status: 'CONNECTED',
        accountLabel: 'Test service',
        metadata: { authType: 'bearer', secretHint: `…${TOKEN.slice(-4)}`, baseUrl: `${base}/v1` },
      });
      expectNoSecrets([list.body], [TOKEN]);
      const stored = await prisma.integrationCredential.findUniqueOrThrow({
        where: { connectionId: id },
      });
      expect(stored.encryptedPayload).toBeTruthy();
      expect(stored.encryptedPayload).not.toContain(TOKEN);

      const providers = await request(server)
        .get('/api/v1/integrations/providers')
        .set(auth())
        .expect(200);
      expect(providers.body).toContainEqual({
        key: 'HTTP',
        configured: true,
        connectionType: 'CREDENTIALS',
      });
    });

    it('rejects invalid credentials and settings without echoing values', async () => {
      const bad = await request(server)
        .post(`${integrations()}/http`)
        .set(auth())
        .send({ name: 'x', credentials: { authType: 'basic', username: 'a:b', password: TOKEN } })
        .expect(422);
      expectNoSecrets([bad.body], [TOKEN]);
      await request(server)
        .post(`${integrations()}/http`)
        .set(auth())
        .send({
          name: 'x',
          credentials: { authType: 'bearer', token: TOKEN },
          baseUrl: 'https://169.254.169.254/latest',
        })
        .expect(422);
      await request(server)
        .post(`${integrations()}/http`)
        .set(auth())
        .send({ name: 'x', credentials: { authType: 'oauth' } })
        .expect(422);
    });

    it('tests a connection through the egress guard and returns the outcome only', async () => {
      const id = await connect({ authType: 'bearer', token: TOKEN });
      respond = (req, res) => {
        res.writeHead(req.headers.authorization === `Bearer ${TOKEN}` ? 200 : 401);
        res.end('private page content');
      };
      const ok = await request(server)
        .post(`${integrations()}/${id}/test`)
        .set(auth())
        .send({ url: `${base}/me` })
        .expect(200);
      expect(ok.body).toEqual({ ok: true, status: 200, durationMs: expect.any(Number) });
      expect(JSON.stringify(ok.body)).not.toContain('private page');

      const blocked = await request(server)
        .post(`${integrations()}/${id}/test`)
        .set(auth())
        .send({ url: 'http://169.254.169.254/latest/meta-data/' })
        .expect(200);
      expect(blocked.body).toMatchObject({ ok: false, category: 'VALIDATION' });
    });

    it('rotates secrets; renames and updates settings; deletes', async () => {
      const id = await connect({ authType: 'bearer', token: TOKEN });
      respond = (req, res) => {
        res.writeHead(req.headers.authorization === `Bearer ${ROTATED}` ? 200 : 401);
        res.end();
      };
      const before = await request(server)
        .post(`${integrations()}/${id}/test`)
        .set(auth())
        .send({ url: `${base}/me` });
      expect(before.body).toMatchObject({ ok: false, status: 401, category: 'PROVIDER_AUTH' });

      const rotated = await request(server)
        .put(`${integrations()}/${id}/credentials`)
        .set(auth())
        .send({ credentials: { authType: 'bearer', token: ROTATED } })
        .expect(200);
      expect(rotated.body.metadata.secretHint).toBe(`…${ROTATED.slice(-4)}`);
      const after = await request(server)
        .post(`${integrations()}/${id}/test`)
        .set(auth())
        .send({ url: `${base}/me` });
      expect(after.body).toMatchObject({ ok: true, status: 200 });

      const renamed = await request(server)
        .patch(`${integrations()}/${id}`)
        .set(auth())
        .send({ name: 'Renamed', allowedHosts: ['api.example.com'] })
        .expect(200);
      expect(renamed.body).toMatchObject({
        accountLabel: 'Renamed',
        metadata: { allowedHosts: ['api.example.com'] },
      });

      await request(server).delete(`${integrations()}/${id}`).set(auth()).expect(204);
      expect(await prisma.integrationCredential.count({ where: { connectionId: id } })).toBe(0);
    });
  });

  describe('http.request (AC-24.1)', () => {
    it('S24.1: POST with templated JSON and bearer auth → condition on the status → log', async () => {
      const connectionId = await connect({ authType: 'bearer', token: TOKEN });
      respond = (req, res) => {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          res.writeHead(401);
          return res.end();
        }
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ticketId: 'T-7', for: JSON.parse(req.body).customer }));
      };
      const id = await publish(
        [
          trigger,
          call({
            method: 'POST',
            url: `${base}/tickets`,
            connectionId,
            body: {
              type: 'json',
              value: {
                customer: '{{ trigger.customerId }}',
                priority: { ref: 'trigger.priority' },
              },
            },
          }),
          {
            key: 'check',
            kind: 'CONDITION',
            type: 'condition',
            config: {
              all: [
                {
                  left: { ref: 'steps.call.output.status' },
                  operator: 'equals',
                  right: { value: 201 },
                },
              ],
            },
          },
          {
            key: 'done',
            kind: 'ACTION',
            type: 'util.log',
            config: { message: 'ticket {{ steps.call.output.body.ticketId }}' },
          },
        ],
        [
          { from: 'trigger', to: 'call' },
          { from: 'call', to: 'check' },
          { from: 'check', to: 'done', branch: 'true' },
        ],
      );
      const { run, step } = await start(id, { customerId: 'C-42', priority: 3 });
      expect(run.status).toBe('SUCCEEDED');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ method: 'POST', url: '/tickets' });
      expect(JSON.parse(seen[0].body)).toEqual({ customer: 'C-42', priority: 3 });
      expect(seen[0].headers['content-type']).toBe('application/json');
      expect(step('call').sanitizedOutput).toMatchObject({
        status: 201,
        body: { ticketId: 'T-7', for: 'C-42' },
        finalUrl: `${base}/tickets`,
      });
      expect(step('done').sanitizedOutput).toEqual({ message: 'ticket T-7' });
    });

    it('supports every method, query, headers, text and form bodies, and relative URLs', async () => {
      const connectionId = await connect(
        { authType: 'bearer', token: TOKEN },
        { baseUrl: `${base}/api` },
      );
      for (const [method, body] of [
        ['GET', undefined],
        ['DELETE', undefined],
        ['PUT', { type: 'text', value: 'hello {{ trigger.name }}' }],
        ['PATCH', { type: 'form', value: { a: '1', b: '{{ trigger.name }}' } }],
        ['HEAD', undefined],
      ] as const) {
        seen.length = 0;
        const { run } = await runCall(
          {
            method,
            url: 'items/{{ trigger.id }}',
            connectionId,
            query: { q: '{{ trigger.name }}', page: '2' },
            headers: { 'X-Trace': 'tr-{{ trigger.id }}', Accept: 'application/json' },
            ...(body && { body }),
          },
          { id: 5, name: 'Ada Lovelace' },
        );
        expect([method, run.status]).toEqual([method, 'SUCCEEDED']);
        expect(seen[0]).toMatchObject({ method, url: '/api/items/5?q=Ada+Lovelace&page=2' });
        expect(seen[0].headers).toMatchObject({ 'x-trace': 'tr-5', accept: 'application/json' });
        if (method === 'PUT') expect(seen[0].body).toBe('hello Ada Lovelace');
        if (method === 'PATCH') {
          expect(seen[0].body).toBe('a=1&b=Ada+Lovelace');
          expect(seen[0].headers['content-type']).toBe('application/x-www-form-urlencoded');
        }
      }
    });

    it('applies basic, API-key header, API-key query and custom-header auth', async () => {
      const cases: [object, (s: Seen) => unknown][] = [
        [{ authType: 'basic', username: 'u', password: TOKEN }, (s) => s.headers.authorization],
        [
          { authType: 'apiKeyHeader', headerName: 'X-Api-Key', value: API_KEY },
          (s) => s.headers['x-api-key'],
        ],
        [
          { authType: 'apiKeyQuery', paramName: 'api_key', value: API_KEY },
          (s) => new URL(s.url, base).searchParams.get('api_key'),
        ],
        [
          { authType: 'customHeaders', headers: { 'X-Tenant': 'acme', 'X-Secret': API_KEY } },
          (s) => [s.headers['x-tenant'], s.headers['x-secret']],
        ],
      ];
      const expected = [
        `Basic ${Buffer.from(`u:${TOKEN}`).toString('base64')}`,
        API_KEY,
        API_KEY,
        ['acme', API_KEY],
      ];
      for (const [i, [credentials, read]] of cases.entries()) {
        seen.length = 0;
        const connectionId = await connect(credentials);
        const { run, step } = await runCall({ url: `${base}/auth`, connectionId });
        expect(run.status).toBe('SUCCEEDED');
        expect(read(seen[0])).toEqual(expected[i]);
        // The credential query parameter never reaches the stored output.
        expectNoSecrets(
          [step('call').sanitizedInput, step('call').sanitizedOutput],
          [API_KEY, TOKEN],
        );
      }
    });

    it('normalises the output: no cookies, capped bodies', async () => {
      const { step } = await runCall({ url: `${base}/echo` });
      const output = step('call').sanitizedOutput as { headers: Record<string, string> };
      expect(output.headers['set-cookie']).toBeUndefined();
      expect(output.headers['content-type']).toBe('application/json');

      respond = (_req, res) => {
        res.setHeader('content-type', 'text/plain');
        res.end('x'.repeat(200_000));
      };
      const big = await runCall({ url: `${base}/big` });
      expect(big.run.status).toBe('SUCCEEDED');
      expect(big.step('call').sanitizedOutput).toMatchObject({ bodyTruncated: true });
      const tooBig = await runCall({ url: `${base}/big`, onLargeResponse: 'error' });
      expect(tooBig.run).toMatchObject({
        status: 'FAILED',
        lastErrorCategory: 'PERMANENT_PROVIDER_ERROR',
      });
    });
  });

  describe('errors and retries (AC-24.3)', () => {
    it('429 is retried after Retry-After; transient 5xx retried for GET', async () => {
      let calls = 0;
      respond = (_req, res) => {
        calls++;
        if (calls === 1) {
          res.writeHead(429, { 'retry-after': '1' });
          return res.end();
        }
        if (calls === 2) {
          res.writeHead(502);
          return res.end();
        }
        res.end('ok');
      };
      const started = Date.now();
      const { run } = await runCall({ url: `${base}/flaky` });
      expect(run.status).toBe('SUCCEEDED');
      expect(calls).toBe(3);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    });

    it('a POST that gets a 5xx is UNCERTAIN_OUTCOME and not sent again', async () => {
      respond = (_req, res) => {
        res.writeHead(500);
        res.end();
      };
      const { run } = await runCall({
        method: 'POST',
        url: `${base}/charge`,
        body: { type: 'json', value: { a: 1 } },
      });
      expect(run).toMatchObject({ status: 'FAILED', lastErrorCategory: 'UNCERTAIN_OUTCOME' });
      expect(seen).toHaveLength(1);
    });

    it('a POST marked idempotent is retried with a stable Idempotency-Key', async () => {
      let calls = 0;
      respond = (_req, res) => {
        res.writeHead(++calls === 1 ? 500 : 200);
        res.end();
      };
      const { run } = await runCall({
        method: 'POST',
        url: `${base}/idem`,
        idempotent: true,
        body: { type: 'json', value: {} },
      });
      expect(run.status).toBe('SUCCEEDED');
      expect(seen).toHaveLength(2);
      expect(seen[0].headers['idempotency-key']).toBeTruthy();
      expect(seen[1].headers['idempotency-key']).toBe(seen[0].headers['idempotency-key']);
    });

    it('4xx fails permanently, or becomes the output with failOn4xx off', async () => {
      respond = (_req, res) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"nope"}');
      };
      const failed = await runCall({ url: `${base}/missing` });
      expect(failed.run).toMatchObject({
        status: 'FAILED',
        lastErrorCategory: 'PERMANENT_PROVIDER_ERROR',
      });
      expect(seen).toHaveLength(1);
      const kept = await runCall({ url: `${base}/missing`, failOn4xx: false });
      expect(kept.run.status).toBe('SUCCEEDED');
      expect(kept.step('call').sanitizedOutput).toMatchObject({
        status: 404,
        body: { error: 'nope' },
      });
    });
  });

  describe('SSRF and credential safety (AC-24.2, AC-24.4)', () => {
    it('a redirect to a private address is blocked', async () => {
      respond = (_req, res) => {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      };
      const { run } = await runCall({ url: `${base}/go` });
      expect(run).toMatchObject({ status: 'FAILED', lastErrorCategory: 'VALIDATION' });
      expect(run.errorMessage).toMatch(/Destination not allowed/);
      expect(seen).toHaveLength(1);
      expect(logs.some(([fields]) => (fields as { egressBlocked?: boolean })?.egressBlocked)).toBe(
        true,
      );
    });

    it('a templated URL that renders to a private address is blocked at run time', async () => {
      const { run } = await runCall(
        { url: '{{ trigger.target }}' },
        { target: 'http://10.0.0.1/admin' },
      );
      expect(run).toMatchObject({ status: 'FAILED', lastErrorCategory: 'VALIDATION' });
    });

    it('credentials are never sent outside the connection allowed hosts', async () => {
      const connectionId = await connect(
        { authType: 'bearer', token: TOKEN },
        { allowedHosts: ['api.example.com'] },
      );
      const { run } = await runCall({ url: `${base}/steal`, connectionId });
      expect(run).toMatchObject({ status: 'FAILED', lastErrorCategory: 'VALIDATION' });
      expect(seen).toEqual([]);
    });

    it('secrets never appear in definitions, step data, API responses or logs', async () => {
      const connectionId = await connect({ authType: 'bearer', token: TOKEN });
      const { run, steps } = await runCall({ url: `${base}/x`, connectionId });
      expect(run.status).toBe('SUCCEEDED');
      expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
      const detail = await request(server)
        .get(`/api/v1/workspaces/${ws}/runs/${run.id}`)
        .set(auth());
      const versions = await prisma.workflowVersion.findMany({ where: { workspaceId: ws } });
      expectNoSecrets([steps, detail.body, versions, logs], [TOKEN, ROTATED, API_KEY]);
    });
  });

  describe('tenant isolation (AC-24.5)', () => {
    it('a connection of another workspace is refused at publish and at execution', async () => {
      const other = await registerUser(server);
      const otherWs = (
        await prisma.workspaceMember.findFirstOrThrow({ where: { userId: other.id } })
      ).workspaceId;
      const foreign = await request(server)
        .post(`/api/v1/workspaces/${otherWs}/integrations/http`)
        .set(bearer(other.accessToken))
        .send({ name: 'theirs', credentials: { authType: 'bearer', token: TOKEN } })
        .expect(201);

      // Publish: the connection id does not exist in this workspace.
      const wf = await request(server)
        .post(workflows())
        .set(auth())
        .send({ name: 'x' })
        .expect(201);
      const definition = {
        schemaVersion: 1,
        nodes: [trigger, call({ url: `${base}/x`, connectionId: foreign.body.id })],
        edges: [{ from: 'trigger', to: 'call' }],
      };
      await request(server)
        .put(`${workflows()}/${wf.body.id}/draft`)
        .set(auth())
        .send({ expectedRevision: 0, definition })
        .expect(200);
      const publish = await request(server)
        .post(`${workflows()}/${wf.body.id}/publish`)
        .set(auth())
        .send({ expectedRevision: 1 })
        .expect(422);
      expect(publish.body.details).toEqual([
        expect.objectContaining({ code: 'CONNECTION_INVALID', nodeKey: 'call' }),
      ]);

      // Execution: a version that references it anyway (bypassing publish) fails without a call.
      const workflow = await createWorkflow(prisma, ws);
      const version = await prisma.workflowVersion.create({
        data: {
          workspaceId: ws,
          workflowId: workflow.id,
          version: 1,
          schemaVersion: 1,
          definition,
          definitionHash: 'x',
        },
      });
      await prisma.workflow.update({
        where: { id: workflow.id },
        data: { activeVersionId: version.id, status: 'PUBLISHED' },
      });
      const queued = await createRun(prisma, version);
      await api.get(RunQueue).enqueue(queued.id);
      const { run } = await settled(queued.id);
      expect(run).toMatchObject({ status: 'FAILED', lastErrorCategory: 'PROVIDER_AUTH' });
      expect(seen).toEqual([]);
    });
  });
});
