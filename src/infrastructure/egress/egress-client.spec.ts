import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import {
  EgressClient,
  EgressNetworkError,
  EgressRequest,
  EgressTimeoutError,
  isPermanentDnsError,
  Resolver,
} from './egress-client';
import { EgressBlockedError, EgressPolicy } from './egress-policy';

const policy: EgressPolicy = {
  allowPlainHttp: true,
  allowPrivateNetworks: false,
  deniedPorts: [25],
  deniedHosts: [],
};

/** Local test service on 127.0.0.1, reachable only through the client's test allow-list. */
describe('egress client (Part 24)', () => {
  let server: Server;
  let port: number;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  const seen: { method?: string; url?: string; headers: IncomingMessage['headers'] }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      handler(req, res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  beforeEach(() => {
    seen.length = 0;
    handler = (_req, res) => res.end('ok');
  });

  const request = (overrides: Partial<EgressRequest> = {}): EgressRequest => ({
    method: 'GET',
    url: `http://127.0.0.1:${port}/x`,
    headers: {},
    timeoutMs: 2_000,
    maxRedirects: 3,
    maxResponseBytes: 1_024,
    ...overrides,
  });
  const client = (resolver?: Resolver) => {
    const c = new EgressClient(policy, resolver);
    c.allowForTests('127.0.0.1', port);
    return c;
  };

  it('without the test allowance, the local service is blocked like any private address', async () => {
    await expect(new EgressClient(policy).send(request())).rejects.toThrow(EgressBlockedError);
    expect(seen).toEqual([]);
  });

  it('refuses the test allowance outside tests', () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new EgressClient(policy).allowForTests('127.0.0.1', port)).toThrow();
    } finally {
      process.env.NODE_ENV = env;
    }
  });

  it('sends the request and returns status, headers and body', async () => {
    handler = (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-custom', 'y');
      res.end(JSON.stringify({ method: req.method }));
    };
    const res = await client().send(
      request({ method: 'post', headers: { 'x-a': '1' }, body: Buffer.from('{"a":1}') }),
    );
    expect(res).toMatchObject({ status: 200, truncated: false, redirects: 0 });
    expect(res.headers).toMatchObject({ 'content-type': 'application/json', 'x-custom': 'y' });
    expect(JSON.parse(res.body.toString())).toEqual({ method: 'POST' });
    expect(seen[0].headers).toMatchObject({ 'x-a': '1', 'content-length': '7' });
  });

  it('resolves names, pins the connection to the vetted address, and keeps the Host header', async () => {
    const resolver = jest.fn<Promise<string[]>, [string]>().mockResolvedValue(['127.0.0.1']);
    await client(resolver).send(request({ url: `http://service.test.example:${port}/p?q=1` }));
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(seen[0]).toMatchObject({
      url: '/p?q=1',
      headers: { host: `service.test.example:${port}` },
    });
  });

  it('DNS rebinding cannot redirect the connection: the name is resolved once and pinned', async () => {
    // First answer is allowed; any later answer would be private — it is never asked for.
    const resolver = jest
      .fn<Promise<string[]>, [string]>()
      .mockResolvedValueOnce(['127.0.0.1'])
      .mockResolvedValue(['10.0.0.1']);
    await client(resolver).send(request({ url: `http://rebind.test.example:${port}/` }));
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });

  it('refuses when any resolved address is private (multiple records, AAAA-only)', async () => {
    const mixed: Resolver = async () => ['93.184.216.34', '10.0.0.1'];
    await expect(client(mixed).send(request({ url: 'https://mixed.example/' }))).rejects.toThrow(
      /resolves to a private/,
    );
    const v6: Resolver = async () => ['fd00::1'];
    await expect(client(v6).send(request({ url: 'https://v6.example/' }))).rejects.toThrow(
      EgressBlockedError,
    );
  });

  it('classifies DNS failures', async () => {
    const nx: Resolver = async () => {
      throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    };
    const err = await client(nx)
      .send(request({ url: 'https://nope.example/' }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(EgressNetworkError);
    expect(isPermanentDnsError(err)).toBe(true);
    const slow: Resolver = async () => {
      throw Object.assign(new Error('again'), { code: 'EAI_AGAIN' });
    };
    const err2 = await client(slow)
      .send(request({ url: 'https://slow.example/' }))
      .catch((e) => e);
    expect(isPermanentDnsError(err2)).toBe(false);
  });

  it('follows redirects and re-checks every hop', async () => {
    handler = (req, res) => {
      if (req.url === '/x') {
        res.writeHead(302, { location: '/y' });
        res.end();
      } else if (req.url === '/y') {
        res.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      } else res.end('final');
    };
    await expect(client().send(request())).rejects.toThrow(/private, loopback/);
    expect(seen.map((s) => s.url)).toEqual(['/x', '/y']);
  });

  it('caps redirects, turns 303 into GET, and drops credentials when the origin changes', async () => {
    handler = (req, res) => {
      if (req.url === '/x') {
        res.writeHead(303, { location: `http://127.0.0.1:${port}/y` });
        res.end();
      } else res.end('done');
    };
    const res = await client().send(
      request({ method: 'POST', body: Buffer.from('a'), headers: { authorization: 'Bearer abc' } }),
    );
    expect(res).toMatchObject({ status: 200, redirects: 1 });
    expect(seen[1]).toMatchObject({ method: 'GET' });
    expect(seen[1].headers.authorization).toBe('Bearer abc'); // same origin keeps it

    seen.length = 0;
    const resolver: Resolver = async () => ['127.0.0.1'];
    handler = (req, res) => {
      if (req.url === '/x') {
        res.writeHead(302, { location: `http://other.test.example:${port}/z` });
        res.end();
      } else res.end('z');
    };
    await client(resolver).send(
      request({
        headers: { authorization: 'Bearer abc', 'x-key': 'k' },
        sensitiveHeaders: ['authorization', 'x-key'],
      }),
    );
    expect(seen[1].headers.authorization).toBeUndefined();
    expect(seen[1].headers['x-key']).toBeUndefined();

    handler = (_req, res) => {
      res.writeHead(302, { location: '/x' });
      res.end();
    };
    await expect(client().send(request({ maxRedirects: 2 }))).rejects.toThrow(
      /more than 2 redirects/,
    );
    const noFollow = await client().send(request({ maxRedirects: 0 }));
    expect(noFollow.status).toBe(302);
  });

  it('applies the per-hop check (connection allowed hosts)', async () => {
    const checkHop = (url: URL) => {
      if (url.pathname !== '/x')
        throw new EgressBlockedError('host not allowed for this connection');
    };
    handler = (_req, res) => {
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    };
    await expect(client().send(request({ checkHop }))).rejects.toThrow(
      /not allowed for this connection/,
    );
  });

  it('truncates large bodies and stops decompression bombs at the cap', async () => {
    handler = (_req, res) => res.end('x'.repeat(5_000));
    const big = await client().send(request());
    expect(big).toMatchObject({ truncated: true });
    expect(big.body.length).toBe(1_024);

    const bomb = gzipSync(Buffer.alloc(5_000_000, 'a'));
    handler = (_req, res) => {
      res.setHeader('content-encoding', 'gzip');
      res.end(bomb);
    };
    const res = await client().send(request());
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBe(1_024);
    expect(res.body.toString()).toBe('a'.repeat(1_024));
  });

  it('times out after sending (outcome uncertain) and reports connection failures before sending', async () => {
    handler = () => undefined; // never answers
    const err = await client()
      .send(request({ timeoutMs: 200 }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(EgressTimeoutError);
    expect(err.sent).toBe(true);

    const closed = new EgressClient(policy);
    closed.allowForTests('127.0.0.1', 1);
    const refused = await closed.send(request({ url: 'http://127.0.0.1:1/' })).catch((e) => e);
    expect(refused).toBeInstanceOf(EgressNetworkError);
    expect(refused).toMatchObject({ phase: 'connect', sent: false });
  });

  it('honours an abort signal', async () => {
    handler = () => undefined;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(client().send(request({ signal: controller.signal }))).rejects.toThrow(
      EgressTimeoutError,
    );
  });
});
