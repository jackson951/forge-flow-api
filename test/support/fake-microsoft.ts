import { createHash, randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

type Scripted = { status?: number; headers?: Record<string, string>; body: object };

const token = (prefix: string) => `${prefix}-${randomBytes(12).toString('hex')}`;

/**
 * In-process stand-in for login.microsoftonline.com (v2 token endpoint) and Graph v1.0.
 * Verifies client credentials and PKCE (S256), issues expiring access tokens, rotates refresh
 * tokens on every refresh, and can be scripted to fail the next token or Graph calls.
 */
export class FakeMicrosoft {
  private server!: Server;
  url = '';
  readonly clientId = '00000000-1111-2222-3333-444444444444';
  readonly clientSecret = 'entra-client-secret-must-never-leak';
  readonly user = {
    id: 'aaaabbbb-0000-1111-2222-333344445555',
    displayName: 'Ada Lovelace',
    userPrincipalName: 'ada@contoso.test',
    mail: 'ada@contoso.test',
  };
  readonly tenantId = '72f988bf-86f1-41af-91ab-2d7cd011db47';
  /** Scopes granted on the authorization code exchange. */
  grantedScopes = 'openid profile offline_access User.Read Tasks.ReadWrite';
  expiresIn = 3600;
  /** Delay for refresh responses (to make concurrent refreshes overlap). */
  refreshDelayMs = 0;

  /** code → expected PKCE challenge. */
  private codes = new Map<string, string>();
  readonly validAccessTokens = new Set<string>();
  readonly validRefreshTokens = new Set<string>();
  readonly issuedRefreshTokens: string[] = [];
  readonly refreshCalls: { refreshToken: string; at: number }[] = [];
  readonly tokenScript: Scripted[] = [];
  readonly graphScript: Scripted[] = [];
  readonly graphCalls: { method: string; path: string; at: number }[] = [];
  readonly tasks: { listId: string; body: Record<string, unknown>; id: string }[] = [];
  readonly lists = [
    { id: 'AAMkADefault==', displayName: 'Tasks', wellknownListName: 'defaultList' },
    { id: 'AAMkADincidents==', displayName: 'Incidents', wellknownListName: 'none' },
    { id: 'AAMkADpage2==', displayName: 'Later', wellknownListName: 'none' },
  ];
  /** When set, the first lists page links to this instead of the real second page. */
  nextLinkOverride?: string;

  /** Registers an authorization code for the PKCE challenge the app sent to /authorize. */
  issueCode(codeChallenge: string): string {
    const code = token('code');
    this.codes.set(code, codeChallenge);
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    const raw = await readBody(req);
    const send = ({ status = 200, headers = {}, body }: Scripted) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'request-id': `req-${this.graphCalls.length}`,
        ...headers,
      });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && /^\/[^/]+\/oauth2\/v2\.0\/token$/.test(url.pathname)) {
      return this.tokenEndpoint(new URLSearchParams(raw), send);
    }
    if (url.pathname.startsWith('/v1.0/')) {
      const path = url.pathname.slice('/v1.0'.length);
      this.graphCalls.push({ method: req.method ?? 'GET', path, at: Date.now() });
      const scripted = this.graphScript.shift();
      if (scripted) return send(scripted);
      const auth = req.headers.authorization ?? '';
      if (!this.validAccessTokens.has(auth.replace(/^Bearer /, ''))) {
        return send({ status: 401, body: { error: { code: 'InvalidAuthenticationToken' } } });
      }
      return this.graph(req.method ?? 'GET', path, url, raw, send);
    }
    send({ status: 404, body: { error: 'not_found' } });
  }

  private async tokenEndpoint(params: URLSearchParams, send: (s: Scripted) => void) {
    if (
      params.get('client_id') !== this.clientId ||
      params.get('client_secret') !== this.clientSecret
    ) {
      return send({ status: 401, body: { error: 'invalid_client' } });
    }
    const grant = params.get('grant_type');
    if (grant === 'refresh_token') {
      this.refreshCalls.push({ refreshToken: params.get('refresh_token')!, at: Date.now() });
      if (this.refreshDelayMs) await new Promise((r) => setTimeout(r, this.refreshDelayMs));
    }
    const scripted = this.tokenScript.shift();
    if (scripted) return send(scripted);

    if (grant === 'authorization_code') {
      const challenge = this.codes.get(params.get('code') ?? '');
      this.codes.delete(params.get('code') ?? '');
      const verifier = params.get('code_verifier') ?? '';
      const computed = createHash('sha256').update(verifier).digest('base64url');
      if (!challenge || computed !== challenge) {
        return send({ status: 400, body: { error: 'invalid_grant', error_description: 'PKCE' } });
      }
      return send({ body: this.issueTokens(this.grantedScopes, true) });
    }
    if (grant === 'refresh_token') {
      const refresh = params.get('refresh_token')!;
      if (!this.validRefreshTokens.has(refresh)) {
        return send({ status: 400, body: { error: 'invalid_grant' } });
      }
      return send({ body: this.issueTokens(this.grantedScopes, false) });
    }
    send({ status: 400, body: { error: 'unsupported_grant_type' } });
  }

  private issueTokens(scope: string, withIdToken: boolean) {
    const access = token('ms-access');
    const refresh = token('ms-refresh');
    this.validAccessTokens.add(access);
    this.validRefreshTokens.add(refresh);
    this.issuedRefreshTokens.push(refresh);
    const idPayload = Buffer.from(
      JSON.stringify({ tid: this.tenantId, oid: this.user.id }),
    ).toString('base64url');
    return {
      token_type: 'Bearer',
      scope,
      expires_in: this.expiresIn,
      access_token: access,
      refresh_token: refresh,
      ...(withIdToken && { id_token: `eyJhbGciOiJub25lIn0.${idPayload}.` }),
    };
  }

  private graph(method: string, path: string, url: URL, raw: string, send: (s: Scripted) => void) {
    if (method === 'GET' && path === '/me') return send({ body: this.user });
    if (method === 'GET' && path === '/me/todo/lists') {
      const page2 = url.searchParams.get('$skiptoken') === 'p2';
      if (page2) return send({ body: { value: this.lists.slice(2) } });
      return send({
        body: {
          value: this.lists.slice(0, 2),
          '@odata.nextLink':
            this.nextLinkOverride ?? `${this.url}/v1.0/me/todo/lists?$skiptoken=p2`,
        },
      });
    }
    const tasks = /^\/me\/todo\/lists\/([^/]+)\/tasks$/.exec(path);
    if (method === 'POST' && tasks) {
      const listId = decodeURIComponent(tasks[1]);
      if (!this.lists.some((l) => l.id === listId)) {
        return send({ status: 404, body: { error: { code: 'ErrorItemNotFound' } } });
      }
      const id = token('task');
      this.tasks.push({ listId, body: JSON.parse(raw), id });
      return send({
        status: 201,
        body: { id, title: JSON.parse(raw).title, status: 'notStarted' },
      });
    }
    send({ status: 404, body: { error: { code: 'ResourceNotFound' } } });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}
