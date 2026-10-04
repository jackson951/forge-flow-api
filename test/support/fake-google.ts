import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

type Scripted = {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  path?: string;
};

const token = (prefix: string) => `${prefix}-${randomBytes(12).toString('hex')}`;
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachment?: string;
}

/**
 * In-process stand-in for Google OAuth (authorize code + PKCE, token, revoke, userinfo), the
 * public keys used to sign Pub/Sub push tokens, and Gmail REST v1 for one mailbox (profile,
 * watch/stop, history with an expiry point, messages, send, modify, labels).
 */
export class FakeGoogle {
  private server!: Server;
  url = '';
  readonly clientId = 'google-client-id.apps.googleusercontent.com';
  readonly clientSecret = ['google', 'client', 'secret', 'canary', 'never', 'leak'].join('-');
  readonly sub = '1098765432101234567890';
  readonly email = 'support@acme.test';
  readonly topic = 'projects/flowforge-test/topics/gmail-push';
  readonly audience = 'https://api.flowforge.test/api/v1/webhooks/gmail';
  readonly serviceAccount = 'push@flowforge-test.iam.gserviceaccount.com';
  grantedScopes =
    'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send email';

  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private codes = new Map<string, string>();
  readonly validAccessTokens = new Set<string>();
  readonly validRefreshTokens = new Set<string>();
  readonly refreshCalls: string[] = [];
  readonly revoked: string[] = [];
  readonly tokenScript: Scripted[] = [];
  readonly apiScript: Scripted[] = [];
  readonly calls: { method: string; path: string; body: unknown }[] = [];
  readonly watches: { topicName: string; labelIds: string[] }[] = [];
  stops = 0;

  historyId = 1000;
  /** history.list with a start below this answers 404 (history expired). */
  oldestHistoryId = 0;
  readonly history: {
    id: number;
    messagesAdded?: { message: { id: string; labelIds: string[] } }[];
    labelsAdded?: { message: { id: string; labelIds: string[] }; labelIds: string[] }[];
  }[] = [];
  readonly messages = new Map<string, FakeMessage>();
  readonly sent: { raw: string; threadId?: string }[] = [];
  private nextMessage = 1;
  private nextPush = 1;

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

  /** A new email arrives in the mailbox (history: messageAdded). */
  receive(email: Partial<FakeMessage> & { subject: string }): FakeMessage {
    const id = `msg${String(this.nextMessage++).padStart(4, '0')}`;
    const message: FakeMessage = {
      id,
      threadId: `thread-${id}`,
      labelIds: ['INBOX', 'UNREAD'],
      from: 'Ada Lovelace <ada@customer.test>',
      to: this.email,
      text: 'Hello, the login page is broken.',
      ...email,
    };
    this.messages.set(id, message);
    this.history.push({
      id: ++this.historyId,
      messagesAdded: [{ message: { id, labelIds: message.labelIds } }],
    });
    return message;
  }

  /** A label is added to an existing message (history: labelAdded). */
  addLabel(id: string, labelId: string): void {
    const message = this.messages.get(id)!;
    message.labelIds.push(labelId);
    this.history.push({
      id: ++this.historyId,
      labelsAdded: [{ message: { id, labelIds: message.labelIds }, labelIds: [labelId] }],
    });
  }

  /** The body Pub/Sub would push, with its signed OIDC token. */
  push(
    overrides: {
      audience?: string;
      email?: string;
      messageId?: string;
      emailAddress?: string;
    } = {},
  ) {
    const now = Math.floor(Date.now() / 1_000);
    const authorization = this.oidc({
      iss: 'https://accounts.google.com',
      aud: overrides.audience ?? this.audience,
      email: overrides.email ?? this.serviceAccount,
      email_verified: true,
      iat: now,
      exp: now + 3_600,
    });
    const data = Buffer.from(
      JSON.stringify({
        emailAddress: overrides.emailAddress ?? this.email,
        historyId: this.historyId,
      }),
    ).toString('base64');
    return {
      authorization,
      body: {
        message: {
          data,
          messageId: overrides.messageId ?? String(9_000_000 + this.nextPush++),
          publishTime: new Date().toISOString(),
        },
        subscription: 'projects/flowforge-test/subscriptions/gmail',
      },
    };
  }

  oidc(claims: Record<string, unknown>): string {
    const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'fake-key-1', typ: 'JWT' }));
    const body = b64url(JSON.stringify(claims));
    const sig = createSign('RSA-SHA256')
      .update(`${head}.${body}`)
      .sign(this.keys.privateKey)
      .toString('base64url');
    return `Bearer ${head}.${body}.${sig}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    const raw = await readBody(req);
    const send = ({ status = 200, headers = {}, body }: Scripted) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const authorized = () =>
      this.validAccessTokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''));

    if (url.pathname === '/certs') {
      return send({
        body: {
          keys: [
            {
              ...this.keys.publicKey.export({ format: 'jwk' }),
              kid: 'fake-key-1',
              alg: 'RS256',
              use: 'sig',
            },
          ],
        },
      });
    }
    if (req.method === 'POST' && url.pathname === '/token')
      return this.tokenEndpoint(new URLSearchParams(raw), send);
    if (req.method === 'POST' && url.pathname === '/revoke') {
      this.revoked.push(new URLSearchParams(raw).get('token') ?? '');
      return send({ body: {} });
    }
    if (url.pathname === '/userinfo') {
      if (!authorized()) return send({ status: 401, body: {} });
      return send({ body: { sub: this.sub, email: this.email, email_verified: true } });
    }
    const gmail = /^\/gmail\/v1\/users\/me(\/.*)$/.exec(url.pathname);
    if (gmail) {
      const path = gmail[1];
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      this.calls.push({ method: req.method ?? 'GET', path: `${path}${url.search}`, body });
      const i = this.apiScript.findIndex((s) => !s.path || path.startsWith(s.path));
      if (i >= 0) return send(this.apiScript.splice(i, 1)[0]);
      if (!authorized())
        return send({ status: 401, body: { error: { code: 401, status: 'UNAUTHENTICATED' } } });
      return this.gmail(req.method ?? 'GET', path, url, body, send);
    }
    send({ status: 404, body: {} });
  }

  private tokenEndpoint(params: URLSearchParams, send: (s: Scripted) => void) {
    if (
      params.get('client_id') !== this.clientId ||
      params.get('client_secret') !== this.clientSecret
    ) {
      return send({ status: 401, body: { error: 'invalid_client' } });
    }
    if (params.get('grant_type') === 'refresh_token')
      this.refreshCalls.push(params.get('refresh_token') ?? '');
    const scripted = this.tokenScript.shift();
    if (scripted) return send(scripted);
    if (params.get('grant_type') === 'authorization_code') {
      const challenge = this.codes.get(params.get('code') ?? '');
      this.codes.delete(params.get('code') ?? '');
      const computed = createHash('sha256')
        .update(params.get('code_verifier') ?? '')
        .digest('base64url');
      if (!challenge || challenge !== computed)
        return send({ status: 400, body: { error: 'invalid_grant' } });
      const access = token('g-access');
      const refresh = token('g-refresh');
      this.validAccessTokens.add(access);
      this.validRefreshTokens.add(refresh);
      return send({
        body: {
          access_token: access,
          refresh_token: refresh,
          expires_in: 3599,
          scope: this.grantedScopes,
          token_type: 'Bearer',
          id_token: 'x.y.z',
        },
      });
    }
    if (params.get('grant_type') === 'refresh_token') {
      if (!this.validRefreshTokens.has(params.get('refresh_token') ?? ''))
        return send({ status: 400, body: { error: 'invalid_grant' } });
      const access = token('g-access');
      this.validAccessTokens.add(access);
      return send({
        body: {
          access_token: access,
          expires_in: 3599,
          scope: this.grantedScopes,
          token_type: 'Bearer',
        },
      }); // Google keeps the refresh token
    }
    send({ status: 400, body: { error: 'unsupported_grant_type' } });
  }

  private gmail(
    method: string,
    path: string,
    url: URL,
    body: Record<string, unknown> | undefined,
    send: (s: Scripted) => void,
  ) {
    const notFound = () =>
      send({ status: 404, body: { error: { code: 404, errors: [{ reason: 'notFound' }] } } });
    if (method === 'GET' && path === '/profile')
      return send({ body: { emailAddress: this.email, historyId: String(this.historyId) } });
    if (method === 'POST' && path === '/watch') {
      this.watches.push({
        topicName: String(body?.topicName),
        labelIds: (body?.labelIds as string[]) ?? [],
      });
      return send({
        body: {
          historyId: String(this.historyId),
          expiration: String(Date.now() + 7 * 86_400_000),
        },
      });
    }
    if (method === 'POST' && path === '/stop') {
      this.stops++;
      return send({ status: 204 });
    }
    if (method === 'GET' && path === '/history') {
      const start = Number(url.searchParams.get('startHistoryId'));
      if (start < this.oldestHistoryId) return notFound();
      const records = this.history.filter((h) => h.id > start);
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      const page = records.slice(offset, offset + 2); // small pages to exercise paging
      return send({
        body: {
          history: page,
          historyId: String(this.historyId),
          ...(offset + 2 < records.length && { nextPageToken: String(offset + 2) }),
        },
      });
    }
    const message = /^\/messages\/([^/]+)(\/modify)?$/.exec(path);
    if (method === 'POST' && path === '/messages/send') {
      this.sent.push({
        raw: Buffer.from(String(body?.raw), 'base64url').toString('utf8'),
        threadId: body?.threadId as string | undefined,
      });
      return send({
        body: {
          id: `sent${this.sent.length}`,
          threadId: (body?.threadId as string) ?? `thread-sent${this.sent.length}`,
          labelIds: ['SENT'],
        },
      });
    }
    if (message && message[1] !== 'send') {
      const m = this.messages.get(decodeURIComponent(message[1]));
      if (!m) return notFound();
      if (method === 'POST' && message[2]) {
        m.labelIds = [
          ...new Set([...m.labelIds, ...((body?.addLabelIds as string[]) ?? [])]),
        ].filter((l) => !((body?.removeLabelIds as string[]) ?? []).includes(l));
        return send({ body: { id: m.id, labelIds: m.labelIds } });
      }
      return send({ body: this.resource(m, url.searchParams.get('format') ?? 'full') });
    }
    if (method === 'GET' && path === '/labels') {
      return send({
        body: {
          labels: [
            { id: 'INBOX', name: 'INBOX', type: 'system' },
            { id: 'Label_support', name: 'support', type: 'user' },
          ],
        },
      });
    }
    notFound();
  }

  private resource(m: FakeMessage, format: string) {
    const headers = [
      { name: 'From', value: m.from },
      { name: 'To', value: m.to },
      { name: 'Subject', value: m.subject },
      { name: 'Message-ID', value: `<${m.id}@mail.customer.test>` },
      { name: 'Reply-To', value: m.from },
    ];
    const parts = [
      ...(m.text ? [{ mimeType: 'text/plain', body: { data: b64url(m.text) } }] : []),
      ...(m.html ? [{ mimeType: 'text/html', body: { data: b64url(m.html) } }] : []),
      ...(m.attachment
        ? [
            {
              mimeType: 'application/pdf',
              filename: m.attachment,
              body: { attachmentId: 'ATTACHMENT-CONTENT-ID', size: 99 },
            },
          ]
        : []),
    ];
    return {
      id: m.id,
      threadId: m.threadId,
      labelIds: m.labelIds,
      snippet: (m.text ?? '').slice(0, 40),
      internalDate: String(Date.now()),
      payload: { mimeType: 'multipart/mixed', headers, ...(format === 'full' && { parts }) },
    };
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
