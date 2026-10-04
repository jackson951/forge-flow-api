import { randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { signJwt } from '../../src/modules/integrations/jira/jira-webhook-auth';

type Scripted = { status?: number; headers?: Record<string, string>; body?: unknown };

const token = (prefix: string) => `${prefix}-${randomBytes(12).toString('hex')}`;

interface FakeIssue {
  id: string;
  key: string;
  fields: Record<string, unknown>;
}

/**
 * In-process stand-in for auth.atlassian.com (3LO token endpoint), api.atlassian.com (`/me`,
 * accessible resources) and Jira Cloud REST v3 on one site. Rotating refresh tokens (a refresh
 * invalidates the previous one), dynamic webhooks, issues, transitions, and scripted failures.
 */
export class FakeJira {
  private server!: Server;
  url = '';
  readonly clientId = 'jira-client-id-test';
  readonly clientSecret = ['jira', 'client', 'secret', 'canary', 'never', 'leak'].join('-');
  readonly accountId = '557058:aaaa-bbbb-cccc';
  readonly cloudId = 'cloud-1111-2222';
  readonly siteUrl = 'https://acme.atlassian.net';
  grantedScopes =
    'read:jira-work write:jira-work read:jira-user manage:jira-webhook read:me offline_access';
  expiresIn = 3600;
  refreshDelayMs = 0;

  private codes = new Set<string>();
  readonly validAccessTokens = new Set<string>();
  readonly validRefreshTokens = new Set<string>();
  readonly refreshCalls: string[] = [];
  readonly tokenScript: Scripted[] = [];
  /** Scripted answers for Jira REST calls (by path prefix match, or any when no path given). */
  readonly apiScript: (Scripted & { path?: string })[] = [];
  readonly calls: { method: string; path: string; body: unknown }[] = [];
  readonly issues = new Map<string, FakeIssue>();
  readonly webhooks = new Map<
    number,
    { url: string; jqlFilter: string; events: string[]; expiresAt: number }
  >();
  private nextIssue = 1;
  private nextWebhook = 1;

  issueCode(): string {
    const code = token('code');
    this.codes.add(code);
    return code;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** An Atlassian-style bearer JWT for a webhook delivery (signed with the client secret). */
  webhookAuthorization(secret = this.clientSecret): string {
    return `Bearer ${signJwt(secret, { iss: 'jira', exp: Math.floor(Date.now() / 1_000) + 300 })}`;
  }

  /** The (only) registered webhook URL's path and query, to deliver to the API. */
  registeredWebhook(): { path: string; id: number; jqlFilter: string } | undefined {
    const [id, hook] = [...this.webhooks.entries()].at(-1) ?? [];
    if (!hook || id === undefined) return undefined;
    const url = new URL(hook.url);
    return { path: `${url.pathname}${url.search}`, id, jqlFilter: hook.jqlFilter };
  }

  addIssue(key: string, fields: Record<string, unknown>): FakeIssue {
    const issue = { id: String(10_000 + this.nextIssue++), key, fields };
    this.issues.set(key, issue);
    return issue;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    const send = ({ status = 200, headers = {}, body: payload }: Scripted) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(payload === undefined ? '' : JSON.stringify(payload));
    };
    const authorized = () =>
      this.validAccessTokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''));

    if (req.method === 'POST' && url.pathname === '/oauth/token')
      return this.tokenEndpoint(body ?? {}, send);
    if (url.pathname === '/me') {
      if (!authorized()) return send({ status: 401, body: {} });
      return send({
        body: { account_id: this.accountId, name: 'Ada Lovelace', email: 'ada@acme.test' },
      });
    }
    if (url.pathname === '/oauth/token/accessible-resources') {
      if (!authorized()) return send({ status: 401, body: {} });
      return send({
        body: [
          {
            id: this.cloudId,
            name: 'acme',
            url: this.siteUrl,
            scopes: ['read:jira-work', 'write:jira-work'],
          },
          {
            id: 'confluence-only',
            name: 'wiki',
            url: 'https://wiki.example',
            scopes: ['read:confluence-content.all'],
          },
        ],
      });
    }
    const match = /^\/ex\/jira\/([^/]+)\/rest\/api\/3(\/.*)$/.exec(url.pathname);
    if (match) {
      const path = match[2];
      this.calls.push({ method: req.method ?? 'GET', path: `${path}${url.search}`, body });
      const i = this.apiScript.findIndex((s) => !s.path || path.startsWith(s.path));
      if (i >= 0) return send(this.apiScript.splice(i, 1)[0]);
      if (!authorized()) return send({ status: 401, body: { errorMessages: ['Unauthorized'] } });
      if (match[1] !== this.cloudId)
        return send({ status: 404, body: { errorMessages: ['Site not found'] } });
      return this.jira(req.method ?? 'GET', path, url, body, send);
    }
    send({ status: 404, body: { error: 'not_found' } });
  }

  private async tokenEndpoint(params: Record<string, unknown>, send: (s: Scripted) => void) {
    if (params.client_id !== this.clientId || params.client_secret !== this.clientSecret) {
      return send({ status: 401, body: { error: 'invalid_client' } });
    }
    if (params.grant_type === 'refresh_token') {
      this.refreshCalls.push(String(params.refresh_token));
      if (this.refreshDelayMs) await new Promise((r) => setTimeout(r, this.refreshDelayMs));
    }
    const scripted = this.tokenScript.shift();
    if (scripted) return send(scripted);
    if (params.grant_type === 'authorization_code') {
      if (!this.codes.delete(String(params.code)))
        return send({ status: 403, body: { error: 'invalid_grant' } });
      return send({ body: this.issueTokens() });
    }
    if (params.grant_type === 'refresh_token') {
      const old = String(params.refresh_token);
      if (!this.validRefreshTokens.delete(old))
        return send({ status: 403, body: { error: 'invalid_grant' } });
      return send({ body: this.issueTokens() }); // rotation: the old refresh token is now invalid
    }
    send({ status: 400, body: { error: 'unsupported_grant_type' } });
  }

  private issueTokens() {
    const access = token('jira-access');
    const refresh = token('jira-refresh');
    this.validAccessTokens.add(access);
    this.validRefreshTokens.add(refresh);
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: this.expiresIn,
      scope: this.grantedScopes,
      token_type: 'Bearer',
    };
  }

  private jira(
    method: string,
    path: string,
    url: URL,
    body: Record<string, unknown> | undefined,
    send: (s: Scripted) => void,
  ) {
    const issueMatch = /^\/issue\/([^/]+)(\/[a-z]+)?$/.exec(path);
    if (method === 'POST' && path === '/issue') {
      const fields = (body?.fields ?? {}) as Record<string, unknown>;
      const project = (fields.project as { key: string }).key;
      const issue = this.addIssue(`${project}-${this.nextIssue}`, {
        ...fields,
        issuetype: { name: (fields.issuetype as { name?: string }).name ?? 'Task' },
        project: { key: project, name: project },
        status: { name: 'To Do', statusCategory: { key: 'new' } },
        created: new Date().toISOString(),
      });
      return send({ status: 201, body: { id: issue.id, key: issue.key, self: 'x' } });
    }
    if (issueMatch) {
      const issue = this.issues.get(decodeURIComponent(issueMatch[1]));
      if (!issue)
        return send({
          status: 404,
          body: {
            errorMessages: ['Issue does not exist or you do not have permission to see it.'],
          },
        });
      const sub = issueMatch[2];
      if (!sub && method === 'GET') return send({ body: issue });
      if (!sub && method === 'PUT') {
        Object.assign(issue.fields, (body?.fields ?? {}) as object);
        return send({ status: 204 });
      }
      if (sub === '/comment' && method === 'POST')
        return send({
          status: 201,
          body: { id: '9001', created: new Date().toISOString(), body: body?.body },
        });
      if (sub === '/transitions' && method === 'GET') {
        return send({
          body: {
            transitions: [
              { id: '21', name: 'Start', to: { name: 'In Progress' } },
              { id: '31', name: 'Finish', to: { name: 'Done' } },
            ],
          },
        });
      }
      if (sub === '/transitions' && method === 'POST') {
        const id = (body?.transition as { id: string }).id;
        issue.fields.status = { name: id === '31' ? 'Done' : 'In Progress' };
        return send({ status: 204 });
      }
      if (sub === '/assignee' && method === 'PUT') {
        issue.fields.assignee = body?.accountId
          ? { accountId: body.accountId, displayName: 'Someone' }
          : null;
        return send({ status: 204 });
      }
    }
    if (method === 'POST' && path === '/search/jql') {
      const project = /project\s*=\s*"?([A-Z]+)/.exec(String(body?.jql ?? ''))?.[1];
      const issues = [...this.issues.values()].filter(
        (i) => !project || (i.fields.project as { key: string }).key === project,
      );
      return send({
        body: { issues: issues.slice(0, Number(body?.maxResults ?? 50)), isLast: true },
      });
    }
    if (method === 'POST' && path === '/webhook') {
      const created = ((body?.webhooks ?? []) as { jqlFilter: string; events: string[] }[]).map(
        (w) => {
          const id = this.nextWebhook++;
          this.webhooks.set(id, {
            url: String(body?.url),
            jqlFilter: w.jqlFilter,
            events: w.events,
            expiresAt: Date.now() + 30 * 86_400_000,
          });
          return { createdWebhookId: id };
        },
      );
      return send({ body: { webhookRegistrationResult: created } });
    }
    if (method === 'PUT' && path === '/webhook/refresh') {
      const expiresAt = Date.now() + 30 * 86_400_000;
      for (const id of (body?.webhookIds ?? []) as number[]) {
        const hook = this.webhooks.get(id);
        if (hook) hook.expiresAt = expiresAt;
      }
      return send({ body: { expirationDate: new Date(expiresAt).toISOString() } });
    }
    if (method === 'DELETE' && path === '/webhook') {
      for (const id of (body?.webhookIds ?? []) as number[]) this.webhooks.delete(id);
      return send({ status: 202 });
    }
    if (method === 'GET' && path === '/project/search') {
      return send({
        body: {
          values: [
            { id: '1', key: 'ENG', name: 'Engineering', lead: { emailAddress: 'lead@acme.test' } },
          ],
        },
      });
    }
    if (method === 'GET' && /^\/issue\/createmeta\/[^/]+\/issuetypes$/.test(path)) {
      return send({
        body: {
          issueTypes: [
            { id: '10001', name: 'Bug', subtask: false },
            { id: '10002', name: 'Sub-task', subtask: true },
          ],
        },
      });
    }
    if (method === 'GET' && /^\/project\/[^/]+\/statuses$/.test(path)) {
      return send({
        body: [
          {
            statuses: [
              { id: '1', name: 'To Do' },
              { id: '3', name: 'Done' },
            ],
          },
          { statuses: [{ id: '3', name: 'Done' }] },
        ],
      });
    }
    if (method === 'GET' && path === '/user/assignable/search') {
      return send({
        body: [
          { accountId: 'acc-1', displayName: 'Ada', emailAddress: 'ada@acme.test', active: true },
          { accountId: 'acc-2', displayName: 'Gone', active: false },
        ],
      });
    }
    send({ status: 404, body: { errorMessages: [`No fake for ${method} ${path}${url.search}`] } });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
