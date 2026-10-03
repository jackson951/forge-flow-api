import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { RunStatus, StepRun } from '@prisma/client';
import request, { Response } from 'supertest';
import { App } from 'supertest/types';
import { AppConfigService } from '../../src/config/app-config.service';
import { Env } from '../../src/config/env.schema';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RunQueue } from '../../src/infrastructure/queue/run-queue.service';
import { CredentialStore } from '../../src/modules/integrations/credentials/credential-store';
import { MicrosoftTokenManager } from '../../src/modules/integrations/microsoft/microsoft-token-manager';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { captureLogs } from '../support/canaries';
import { createTestApp } from '../support/create-app';
import { createTestWorker, waitFor } from '../support/create-worker';
import { FakeMicrosoft } from '../support/fake-microsoft';
import { truncateAll } from '../support/test-database';
import { TestNodeControl } from '../support/test-node-types';

const fake = new FakeMicrosoft();

class MicrosoftTestConfig extends AppConfigService {
  override get<K extends keyof Env>(key: K): Env[K] {
    const overrides: Partial<Record<keyof Env, string>> = {
      MICROSOFT_CLIENT_ID: fake.clientId,
      MICROSOFT_CLIENT_SECRET: fake.clientSecret,
      MICROSOFT_TENANT_ID: 'common',
      MICROSOFT_LOGIN_URL: fake.url,
      MICROSOFT_GRAPH_URL: `${fake.url}/v1.0`,
      OAUTH_REDIRECT_BASE_URL: 'http://localhost:3000/api/v1/integrations',
      FRONTEND_URL: 'http://frontend.test',
    };
    return (overrides[key] ?? super.get(key)) as Env[K];
  }
}

describe('Microsoft Graph integration (integration)', () => {
  let api: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let worker: TestingModule;
  let admin: RegisteredUser;
  let outsider: RegisteredUser;
  let ws: string;
  let connectionId: string;
  let workflowId: string;
  const responses: string[] = [];
  const logged: unknown[][] = [];

  const track = (res: Response) => {
    responses.push(JSON.stringify(res.headers) + res.text);
    return res;
  };
  const asAdmin = () => bearer(admin.accessToken);
  const integrations = (workspace = ws) => `/api/v1/workspaces/${workspace}/integrations`;
  const credentials = () => api.get(CredentialStore);

  async function startConnect(): Promise<URL> {
    const res = track(
      await request(server).post(`${integrations()}/MICROSOFT/connect`).set(asAdmin()),
    );
    expect(res.status).toBe(201);
    return new URL(res.body.url);
  }

  /** Simulates the browser round trip: Entra issues a code for the challenge it was given. */
  async function connect(): Promise<URL> {
    const authorize = await startConnect();
    const code = fake.issueCode(authorize.searchParams.get('code_challenge')!);
    return callback({ code, state: authorize.searchParams.get('state')! });
  }

  async function callback(query: Record<string, string>): Promise<URL> {
    const res = track(
      await request(server).get('/api/v1/integrations/microsoft/callback').query(query),
    );
    expect(res.status).toBe(302);
    return new URL(res.headers.location);
  }

  /** Moves the stored access token's expiry (simulates time passing). */
  async function expireAccessToken(inMs: number) {
    const current = (await credentials().get(ws, connectionId))!;
    await credentials().save(connectionId, {
      accessToken: current.accessToken,
      refreshToken: current.refreshToken,
      accessTokenExpiresAt: new Date(Date.now() + inMs),
    });
  }

  async function publishTaskWorkflow() {
    const base = `/api/v1/workspaces/${ws}/workflows`;
    const wf = await request(server).post(base).set(asAdmin()).send({ name: 'To Do' });
    const draft = await request(server)
      .put(`${base}/${wf.body.id}/draft`)
      .set(asAdmin())
      .send({
        expectedRevision: 0,
        definition: {
          schemaVersion: 1,
          nodes: [
            { key: 'start', kind: 'TRIGGER', type: 'manual.trigger', config: {} },
            {
              key: 'task',
              kind: 'ACTION',
              type: 'microsoft.todo.createTask',
              config: {
                connectionId,
                listId: 'AAMkADincidents==',
                title: 'Follow up: {{ trigger.title }}',
                body: 'Reported by {{ trigger.reporter }}',
                dueDate: '{{ trigger.due }}',
              },
            },
          ],
          edges: [{ from: 'start', to: 'task' }],
        },
      });
    expect(draft.body.issues).toEqual([]);
    const published = track(
      await request(server)
        .post(`${base}/${wf.body.id}/publish`)
        .set(asAdmin())
        .send({ expectedRevision: 1 }),
    );
    expect(published.status).toBe(201);
    workflowId = wf.body.id;
  }

  async function run(input: Record<string, unknown>) {
    const started = await request(server)
      .post(`/api/v1/workspaces/${ws}/workflows/${workflowId}/runs`)
      .set(asAdmin())
      .send({ input })
      .expect(202);
    const done = await waitFor(
      async () => {
        const r = await prisma.workflowRun.findUniqueOrThrow({ where: { id: started.body.runId } });
        return (['SUCCEEDED', 'FAILED'] as RunStatus[]).includes(r.status) ? r : undefined;
      },
      { what: 'Microsoft run' },
    );
    const steps = await prisma.stepRun.findMany({ where: { runId: done.id } });
    return { run: done, steps: Object.fromEntries(steps.map((s: StepRun) => [s.nodeKey, s])) };
  }

  const connectionStatus = async () =>
    (await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })).status;

  beforeAll(async () => {
    captureLogs(logged);
    await fake.start();
    const useFakes = (b: TestingModuleBuilder) =>
      b.overrideProvider(AppConfigService).useClass(MicrosoftTestConfig);
    api = await createTestApp(useFakes);
    server = api.getHttpServer();
    prisma = api.get(PrismaService);
    worker = await createTestWorker(new TestNodeControl(), useFakes);
    await truncateAll(prisma);
    admin = await registerUser(server);
    outsider = await registerUser(server);
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: admin.id } }))
      .workspaceId;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await worker?.close();
    await api.get(RunQueue).queue.obliterate({ force: true });
    await api.close();
    await fake.stop();
  });

  describe('connect flow (AC-14.1, AC-14.2)', () => {
    it('requests only the listed delegated scopes, with PKCE S256 and state', async () => {
      const providers = await request(server).get('/api/v1/integrations/providers').set(asAdmin());
      expect(providers.body).toContainEqual({
        key: 'MICROSOFT',
        configured: true,
        connectionType: 'OAUTH',
      });

      const url = await startConnect();
      expect(url.origin + url.pathname).toBe(`${fake.url}/common/oauth2/v2.0/authorize`);
      const params = Object.fromEntries(url.searchParams);
      expect(params).toEqual({
        client_id: fake.clientId,
        response_type: 'code',
        redirect_uri: 'http://localhost:3000/api/v1/integrations/microsoft/callback',
        response_mode: 'query',
        scope: 'openid profile offline_access User.Read Tasks.ReadWrite',
        state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      // The verifier is stored only encrypted, never as the challenge or in plaintext.
      const stored = await prisma.oAuthState.findFirstOrThrow({
        where: { provider: 'MICROSOFT' },
        orderBy: { createdAt: 'desc' },
      });
      expect(stored.encryptedCodeVerifier).toMatch(/^v1\.test1\./);
    });

    it('exchanges the code with the PKCE verifier and stores encrypted tokens and profile', async () => {
      const location = await connect();
      expect(location.searchParams.get('status')).toBe('connected');
      connectionId = location.searchParams.get('connectionId')!;

      const connection = await prisma.integrationConnection.findUniqueOrThrow({
        where: { id: connectionId },
        include: { credential: true },
      });
      expect(connection).toMatchObject({
        provider: 'MICROSOFT',
        status: 'CONNECTED',
        externalAccountId: fake.user.id,
        accountLabel: 'ada@contoso.test',
        scopes: ['openid', 'profile', 'offline_access', 'User.Read', 'Tasks.ReadWrite'],
        metadata: {
          displayName: 'Ada Lovelace',
          userPrincipalName: 'ada@contoso.test',
          tenantId: fake.tenantId,
        },
      });
      const c = connection.credential!;
      expect(c.encryptedAccessToken).toMatch(/^v1\.test1\./);
      expect(c.encryptedRefreshToken).toMatch(/^v1\.test1\./);
      expect(c.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
      const raw = JSON.stringify(connection);
      for (const t of fake.validAccessTokens) expect(raw).not.toContain(t);
      expect(raw).not.toContain(fake.issuedRefreshTokens[0]);
    });

    it('rejects bad and reused state, denied consent and a wrong PKCE verifier', async () => {
      expect((await callback({ code: 'x', state: 'forged' })).searchParams.get('reason')).toBe(
        'invalid_state',
      );
      const a = await startConnect();
      const code = fake.issueCode(a.searchParams.get('code_challenge')!);
      const state = a.searchParams.get('state')!;
      await callback({ code, state });
      expect((await callback({ code, state })).searchParams.get('reason')).toBe('invalid_state');

      const denied = await startConnect();
      expect(
        (
          await callback({
            error: 'access_denied',
            error_description: 'The user declined',
            state: denied.searchParams.get('state')!,
          })
        ).searchParams.get('reason'),
      ).toBe('denied');

      // A code issued for a different challenge (intercepted code) fails PKCE.
      const b = await startConnect();
      const stolen = fake.issueCode('some-other-challenge-value-0000000000000000');
      expect(
        (await callback({ code: stolen, state: b.searchParams.get('state')! })).searchParams.get(
          'reason',
        ),
      ).toBe('provider_error');
      expect(await prisma.integrationConnection.count({ where: { provider: 'MICROSOFT' } })).toBe(
        1,
      );
    });

    it('refuses partial consent without Tasks.ReadWrite', async () => {
      fake.grantedScopes = 'openid profile offline_access User.Read';
      try {
        expect((await connect()).searchParams.get('reason')).toBe('not_authorized');
      } finally {
        fake.grantedScopes = 'openid profile offline_access User.Read Tasks.ReadWrite';
      }
    });
  });

  describe('To Do lists (FR-14.4)', () => {
    const lists = (id = connectionId, token = admin.accessToken, workspace = ws) =>
      request(server)
        .get(`${integrations(workspace)}/${id}/microsoft/todo-lists`)
        .set(bearer(token))
        .then(track);

    it('returns all pages of lists, ids and names only', async () => {
      const res = await lists();
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        { id: 'AAMkADefault==', displayName: 'Tasks', isDefault: true },
        { id: 'AAMkADincidents==', displayName: 'Incidents', isDefault: false },
        { id: 'AAMkADpage2==', displayName: 'Later', isDefault: false },
      ]);
    });

    it('never follows a paging link off the Graph host (token stays on Graph)', async () => {
      fake.nextLinkOverride = 'https://evil.example/collect';
      try {
        const res = await lists();
        expect(res.status).toBe(422);
        expect(res.body.message).toMatch(/unexpected paging link/);
        expect(fake.graphCalls.some((c) => c.path.includes('evil'))).toBe(false);
      } finally {
        fake.nextLinkOverride = undefined;
      }
    });

    it('is scoped to the workspace', async () => {
      const outsiderWs = (
        await prisma.workspaceMember.findFirstOrThrow({ where: { userId: outsider.id } })
      ).workspaceId;
      expect((await lists(connectionId, outsider.accessToken, outsiderWs)).status).toBe(404);
      expect((await lists(connectionId, outsider.accessToken)).status).toBe(404);
    });
  });

  describe('createTask action (AC-14.5)', () => {
    beforeAll(publishTaskWorkflow);

    it('creates the task as the connected user; task id stored as externalRef', async () => {
      const { run: done, steps } = await run({
        title: 'Login page crashes',
        reporter: 'octocat',
        due: '2026-10-15',
      });
      expect(done.status).toBe('SUCCEEDED');
      const task = fake.tasks[fake.tasks.length - 1];
      expect(task.listId).toBe('AAMkADincidents==');
      expect(task.body).toEqual({
        title: 'Follow up: Login page crashes',
        body: { content: 'Reported by octocat', contentType: 'text' },
        dueDateTime: { dateTime: '2026-10-15T00:00:00', timeZone: 'UTC' },
      });
      expect(steps.task).toMatchObject({
        status: 'SUCCEEDED',
        externalRef: task.id,
        sanitizedOutput: { taskId: task.id, listId: 'AAMkADincidents==' },
      });
    });

    it('fails clearly on an invalid due date without calling Graph', async () => {
      const before = fake.tasks.length;
      const { run: done, steps } = await run({ title: 'x', reporter: 'y', due: '15/10/2026' });
      expect(done.status).toBe('FAILED');
      expect(steps.task).toMatchObject({
        errorCategory: 'VALIDATION',
        errorMessage: 'dueDate must be a date in YYYY-MM-DD format',
      });
      expect(fake.tasks.length).toBe(before);
    });
  });

  describe('token refresh (AC-14.3)', () => {
    it('refreshes a token expiring within 5 minutes and persists the rotated refresh token', async () => {
      const oldRefresh = (await credentials().get(ws, connectionId))!.refreshToken!;
      await expireAccessToken(60_000);
      const refreshesBefore = fake.refreshCalls.length;

      const { run: done } = await run({ title: 'Refresh me', reporter: 'z', due: '' });

      expect(done.status).toBe('SUCCEEDED');
      expect(fake.refreshCalls.length).toBe(refreshesBefore + 1);
      expect(fake.refreshCalls[fake.refreshCalls.length - 1].refreshToken).toBe(oldRefresh);
      const stored = (await credentials().get(ws, connectionId))!;
      expect(stored.refreshToken).toBe(
        fake.issuedRefreshTokens[fake.issuedRefreshTokens.length - 1],
      );
      expect(stored.refreshToken).not.toBe(oldRefresh);
      expect(stored.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    });

    it('serialises concurrent refreshes across processes: one refresh call (FR-14.3)', async () => {
      await expireAccessToken(-1_000);
      fake.refreshDelayMs = 300;
      const before = fake.refreshCalls.length;
      try {
        // The API and the worker each have their own token manager (as separate processes do).
        const tokens = await Promise.all([
          api.get(MicrosoftTokenManager).accessToken(ws, connectionId),
          worker.get(MicrosoftTokenManager).accessToken(ws, connectionId),
          api.get(MicrosoftTokenManager).accessToken(ws, connectionId),
          worker.get(MicrosoftTokenManager).accessToken(ws, connectionId),
        ]);
        expect(fake.refreshCalls.length).toBe(before + 1);
        expect(new Set(tokens).size).toBe(1);
        expect(fake.validAccessTokens.has(tokens[0])).toBe(true);
      } finally {
        fake.refreshDelayMs = 0;
      }
    });

    it('a 401 from Graph forces one refresh and retries (token revoked early)', async () => {
      const current = (await credentials().get(ws, connectionId))!.accessToken!;
      fake.validAccessTokens.delete(current); // still "fresh" by expiry, but rejected
      const before = fake.refreshCalls.length;
      const tasksBefore = fake.tasks.length;

      const { run: done } = await run({ title: 'After 401', reporter: 'z', due: '' });

      expect(done.status).toBe('SUCCEEDED');
      expect(fake.refreshCalls.length).toBe(before + 1);
      expect(fake.tasks.length).toBe(tasksBefore + 1);
      expect(await connectionStatus()).toBe('CONNECTED');
    });

    it('a 401 even after a fresh token is an account limitation, not lost consent (no To Do mailbox)', async () => {
      // Graph answers 401 for both calls: the original token and the one just refreshed.
      const unauthorized = { status: 401, body: { error: { code: 'UnknownError' } } };
      fake.graphScript.push(unauthorized, unauthorized);
      const refreshesBefore = fake.refreshCalls.length;
      const tasksBefore = fake.tasks.length;

      const { run: done, steps } = await run({ title: 'Guest account', reporter: 'z', due: '' });

      expect(done.status).toBe('FAILED');
      expect(fake.refreshCalls.length).toBe(refreshesBefore + 1);
      expect(steps.task).toMatchObject({
        errorCategory: 'PERMANENT_PROVIDER_ERROR',
        attemptCount: 1,
      });
      expect(steps.task.errorMessage).toMatch(/cannot use Microsoft To Do/);
      expect(fake.tasks.length).toBe(tasksBefore);
      expect(await connectionStatus()).toBe('CONNECTED');

      fake.graphScript.push(unauthorized, unauthorized);
      const lists = await request(server)
        .get(`${integrations()}/${connectionId}/microsoft/todo-lists`)
        .set(asAdmin());
      expect(lists.status).toBe(422);
      expect(lists.body.message).toMatch(/Exchange Online mailbox/);
      expect(await connectionStatus()).toBe('CONNECTED');
    });

    it('honours Graph throttling (429 Retry-After) before retrying the step (AC-14.6)', async () => {
      fake.graphScript.push({
        status: 429,
        headers: { 'retry-after': '1' },
        body: { error: { code: 'TooManyRequests' } },
      });
      const tasksBefore = fake.tasks.length;
      const { run: done, steps } = await run({ title: 'Throttled', reporter: 'z', due: '' });

      expect(done.status).toBe('SUCCEEDED');
      expect(fake.tasks.length).toBe(tasksBefore + 1);
      const posts = fake.graphCalls.filter((c) => c.method === 'POST').slice(-2);
      expect(posts[1].at - posts[0].at).toBeGreaterThanOrEqual(950);
      expect(steps.task.attemptCount).toBe(2);
    });

    it("FlowForge's own app credentials failing is a server error, not the user's (invalid_client)", async () => {
      await expireAccessToken(-1_000);
      fake.tokenScript.push({ status: 401, body: { error: 'invalid_client' } });
      const res = track(
        await request(server)
          .get(`${integrations()}/${connectionId}/microsoft/todo-lists`)
          .set(asAdmin()),
      );
      expect(res.status).toBe(503);
      expect(JSON.stringify(logged)).toContain("Microsoft rejected FlowForge's app credentials");
      expect(await connectionStatus()).toBe('CONNECTED');
    });

    it('revoked consent (invalid_grant) → step PROVIDER_AUTH, connection NEEDS_ATTENTION (AC-14.4)', async () => {
      await expireAccessToken(-1_000);
      fake.validRefreshTokens.clear(); // consent revoked / password reset
      const tasksBefore = fake.tasks.length;

      const { run: done, steps } = await run({ title: 'After revoke', reporter: 'z', due: '' });

      expect(done.status).toBe('FAILED');
      expect(steps.task).toMatchObject({
        status: 'FAILED',
        errorCategory: 'PROVIDER_AUTH',
        attemptCount: 1,
      });
      expect(steps.task.errorMessage).toMatch(/reconnect Microsoft/);
      expect(fake.tasks.length).toBe(tasksBefore);
      expect(await connectionStatus()).toBe('NEEDS_ATTENTION');
      const lists = await request(server)
        .get(`${integrations()}/${connectionId}/microsoft/todo-lists`)
        .set(asAdmin());
      expect(lists.status).toBe(409);

      // Reconnecting the same account restores the connection with fresh tokens.
      const location = await connect();
      expect(location.searchParams.get('connectionId')).toBe(connectionId);
      expect(await connectionStatus()).toBe('CONNECTED');
      expect((await run({ title: 'Back again', reporter: 'z', due: '' })).run.status).toBe(
        'SUCCEEDED',
      );
    });
  });

  describe('disconnect', () => {
    it('deletes the stored tokens', async () => {
      const res = track(
        await request(server).delete(`${integrations()}/${connectionId}`).set(asAdmin()),
      );
      expect(res.status).toBe(204);
      expect(await prisma.integrationCredential.count({ where: { connectionId } })).toBe(0);
    });
  });

  it('never exposes tokens, the client secret or the PKCE verifier in responses or logs', async () => {
    const secrets = [fake.clientSecret, ...fake.validAccessTokens, ...fake.issuedRefreshTokens];
    const all = responses.join('\n');
    const logs = JSON.stringify(logged);
    expect(responses.length).toBeGreaterThan(10);
    expect(logs).toContain('Microsoft To Do task created');
    for (const secret of secrets) {
      expect(all).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    const steps = await prisma.stepRun.findMany({
      select: { sanitizedInput: true, sanitizedOutput: true, errorMessage: true },
    });
    const stored = JSON.stringify(steps);
    for (const secret of secrets) expect(stored).not.toContain(secret);
  });
});
