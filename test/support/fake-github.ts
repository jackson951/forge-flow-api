import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { createVerify } from 'node:crypto';

/**
 * In-process stand-in for github.com + api.github.com, implementing only the endpoints
 * FlowForge calls. It verifies the app JWT with the real public key, so signing is tested.
 */
export class FakeGitHub {
  private server!: Server;
  url = '';
  /** Installation ids the authorizing user can access (via /user/installations). */
  userInstallations = new Set<number>([123]);
  /** Installations the app knows about. */
  installations = new Map<number, { login: string; type: string }>([
    [123, { login: 'Octo-Org', type: 'Organization' }],
  ]);
  repositories = [{ full_name: 'Octo-Org/Hello-World', private: false }];
  /** Next status to force on /installation/repositories (e.g. 401 revoked, 429 rate limit). */
  repositoriesStatus = 200;
  readonly calls: string[] = [];
  private issuedTokens = new Set<string>();

  constructor(private readonly appPublicKey: string) {}

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
    const auth = req.headers.authorization ?? '';
    this.calls.push(`${req.method} ${url.pathname}`);
    const send = (status: number, body: object, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      const body = JSON.parse(await readBody(req)) as { code?: string; client_secret?: string };
      if (body.code !== 'good-code' || !body.client_secret)
        return send(200, { error: 'bad_verification_code' });
      return send(200, { access_token: 'ghu_user_token', token_type: 'bearer' });
    }

    if (url.pathname === '/user/installations') {
      if (auth !== 'token ghu_user_token') return send(401, { message: 'Bad credentials' });
      return send(200, { installations: [...this.userInstallations].map((id) => ({ id })) });
    }

    const installation = url.pathname.match(/^\/app\/installations\/(\d+)(\/access_tokens)?$/);
    if (installation) {
      if (!this.validAppJwt(auth)) return send(401, { message: 'Invalid JWT' });
      const id = Number(installation[1]);
      const account = this.installations.get(id);
      if (!account) return send(404, { message: 'Not Found' });
      if (installation[2]) {
        const token = `ghs_installation_${id}_${this.issuedTokens.size}`;
        this.issuedTokens.add(token);
        return send(201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      return send(200, { id, account, repository_selection: 'selected' });
    }

    if (url.pathname === '/installation/repositories') {
      if (!this.issuedTokens.has(auth.replace('token ', '')))
        return send(401, { message: 'Bad credentials' });
      if (this.repositoriesStatus === 429)
        return send(429, { message: 'rate limited' }, { 'retry-after': '30' });
      if (this.repositoriesStatus !== 200)
        return send(this.repositoriesStatus, { message: 'nope' });
      return send(200, { total_count: this.repositories.length, repositories: this.repositories });
    }

    send(404, { message: 'Not Found' });
  }

  private validAppJwt(authorization: string): boolean {
    const [h, p, sig] = authorization.replace('Bearer ', '').split('.');
    if (!h || !p || !sig) return false;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as { exp: number };
    return (
      payload.exp > Date.now() / 1000 &&
      createVerify('RSA-SHA256').update(`${h}.${p}`).verify(this.appPublicKey, sig, 'base64url')
    );
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString()));
    req.on('end', () => resolve(data));
  });
}
