import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { FAKE_SECRETS } from './fake-secrets';

type Scripted = { status?: number; headers?: Record<string, string>; body: object };

/**
 * In-process stand-in for slack.com/api with the methods FlowForge calls. Checks client
 * credentials and bot tokens like Slack does, records posted messages, and can be scripted
 * to answer the next chat.postMessage calls with errors (rate limit, revoked token…).
 */
export class FakeSlack {
  private server!: Server;
  url = '';
  readonly clientId = '1234.5678';
  readonly clientSecret = 'slack-client-secret-must-never-leak';
  /** The bot token issued by oauth.v2.access (token-shaped, assembled at runtime). */
  readonly botToken = FAKE_SECRETS.slackAccess;
  team = { id: 'T0TEAM1', name: 'Acme Corp' };
  revokedTokens = new Set<string>();
  readonly messages: { channel: string; text: string; ts: string; at: number }[] = [];
  readonly calls: { method: string; at: number }[] = [];
  /** Answers for the next chat.postMessage calls, in order (then normal behaviour). */
  readonly postMessageScript: Scripted[] = [];
  private tsCounter = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = new URL(req.url ?? '/', this.url).pathname.replace(/^\/api\//, '');
    this.calls.push({ method, at: Date.now() });
    const params = Object.fromEntries(new URLSearchParams(await readBody(req)));
    const send = ({ status = 200, headers = {}, body }: Scripted) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization ?? '';
    const bearerOk = auth === `Bearer ${this.botToken}` && !this.revokedTokens.has(this.botToken);

    switch (method) {
      case 'oauth.v2.access': {
        const expected = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
        if (auth !== expected) return send({ body: { ok: false, error: 'invalid_client' } });
        if (params.code !== 'good-slack-code')
          return send({ body: { ok: false, error: 'invalid_code' } });
        this.revokedTokens.delete(this.botToken);
        return send({
          body: {
            ok: true,
            access_token: this.botToken,
            token_type: 'bot',
            scope: 'chat:write,channels:read,groups:read',
            bot_user_id: 'U0BOT',
            app_id: 'A0APP',
            team: this.team,
            enterprise: null,
            is_enterprise_install: false,
          },
        });
      }
      case 'chat.postMessage': {
        const scripted = this.postMessageScript.shift();
        if (scripted) return send(scripted);
        if (!bearerOk) return send({ body: { ok: false, error: 'invalid_auth' } });
        const ts = `1700000000.${String(++this.tsCounter).padStart(6, '0')}`;
        this.messages.push({ channel: params.channel, text: params.text, ts, at: Date.now() });
        return send({ body: { ok: true, channel: params.channel, ts } });
      }
      case 'conversations.list':
        if (!bearerOk) return send({ body: { ok: false, error: 'token_revoked' } });
        return send({
          body: {
            ok: true,
            channels: [
              { id: 'C0GENERAL', name: 'general', is_private: false, purpose: { value: 'x' } },
              { id: 'G0OPS', name: 'ops', is_private: true },
            ],
            response_metadata: { next_cursor: '' },
          },
        });
      case 'auth.revoke':
        if (!bearerOk) return send({ body: { ok: false, error: 'invalid_auth' } });
        this.revokedTokens.add(this.botToken);
        return send({ body: { ok: true, revoked: true } });
      default:
        return send({ status: 404, body: { ok: false, error: 'unknown_method' } });
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}
