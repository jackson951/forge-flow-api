import { lookup as dnsLookup } from 'node:dns/promises';
import { IncomingMessage, request as httpRequest, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, LookupFunction } from 'node:net';
import { Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import {
  checkResolvedAddresses,
  checkUrl,
  EgressBlockedError,
  EgressPolicy,
} from './egress-policy';

export type Resolver = (hostname: string) => Promise<string[]>;

/** All A/AAAA records, as the system resolver returns them. */
export const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export interface EgressRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Buffer;
  /** Whole exchange, all redirects included. */
  timeoutMs: number;
  maxRedirects: number;
  /** Bytes read from the (decompressed) body; anything beyond is dropped and flagged. */
  maxResponseBytes: number;
  signal?: AbortSignal;
  /** Checked for every hop (e.g. a connection's allowed hosts). Throw to refuse. */
  checkHop?: (url: URL) => void;
  /** Header names removed when a redirect leaves the original origin (credentials). */
  sensitiveHeaders?: string[];
}

export interface EgressResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  finalUrl: URL;
  redirects: number;
  durationMs: number;
}

/** Network failure. `sent`: the request may have reached the server (outcome unknown). */
export class EgressNetworkError extends Error {
  constructor(
    readonly code: string,
    readonly phase: 'dns' | 'connect' | 'exchange',
    readonly sent: boolean,
  ) {
    super(`Request failed (${phase}: ${code})`);
    this.name = 'EgressNetworkError';
  }
}

export class EgressTimeoutError extends Error {
  constructor(readonly sent: boolean) {
    super('Request timed out');
    this.name = 'EgressTimeoutError';
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DNS_PERMANENT = new Set(['ENOTFOUND', 'ENODATA', 'EAI_NONAME']);

/**
 * The only way user-chosen destinations are contacted (http.request, connection tests,
 * http.poll). Every hop: static URL checks → resolve all addresses → refuse if any is
 * blocked → connect to the vetted address only (pinned `lookup`, TLS name = original host),
 * so a DNS answer that changes between check and connect cannot reach another address.
 * Redirects are followed by hand and re-checked; no cookies, no connection reuse.
 */
export class EgressClient {
  /** `address:port` pairs reachable despite the policy — integration tests only. */
  private readonly testAllowed = new Set<string>();
  /** Host names answered locally instead of by DNS — integration tests only. */
  private readonly testHosts = new Map<string, string>();

  constructor(
    private readonly policy: EgressPolicy,
    private readonly resolver: Resolver = systemResolver,
  ) {}

  /** Lets integration tests reach their local test service. Refused outside NODE_ENV=test. */
  allowForTests(address: string, port: number, hostname?: string): void {
    if (process.env.NODE_ENV !== 'test') throw new Error('allowForTests is for tests only');
    this.testAllowed.add(`${address}:${port}`);
    if (hostname) this.testHosts.set(hostname.toLowerCase(), address);
  }

  async send(req: EgressRequest): Promise<EgressResponse> {
    const started = Date.now();
    const deadline = started + req.timeoutMs;
    let url = new URL(req.url);
    const origin = url.origin;
    let method = req.method.toUpperCase();
    let body = req.body;
    let headers = { ...req.headers };

    for (let redirects = 0; ; redirects++) {
      const target = await this.vet(url);
      req.checkHop?.(url);
      const response = await this.exchange(url, target, method, headers, body, deadline, req);
      const location = response.headers.location;
      if (!REDIRECTS.has(response.status) || !location || req.maxRedirects === 0) {
        return { ...response, finalUrl: url, redirects, durationMs: Date.now() - started };
      }
      if (redirects >= req.maxRedirects) {
        throw new EgressBlockedError(`more than ${req.maxRedirects} redirects`);
      }
      const next = new URL(location, url);
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === 'POST')
      ) {
        method = 'GET';
        body = undefined;
        headers = omit(headers, ['content-type', 'content-length']);
      }
      if (next.origin !== origin && req.sensitiveHeaders?.length) {
        headers = omit(headers, req.sensitiveHeaders);
      }
      url = next;
    }
  }

  /** Static checks, then DNS: returns the single address to connect to. */
  private async vet(url: URL): Promise<{ address: string; family: 4 | 6 }> {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    const allowedForTest = (a: string) => this.testAllowed.has(`${a}:${port}`);
    const checked = checkUrl(
      url,
      isIP(host) && allowedForTest(host)
        ? { ...this.policy, allowPrivateNetworks: true }
        : this.policy,
    );
    if (checked.literalAddress) {
      return { address: checked.literalAddress, family: isIP(checked.literalAddress) as 4 | 6 };
    }
    let addresses: string[];
    try {
      const testAddress = this.testHosts.get(checked.hostname);
      addresses = testAddress ? [testAddress] : await this.resolver(checked.hostname);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'EDNS';
      throw new EgressNetworkError(code, 'dns', false);
    }
    if (!addresses.every(allowedForTest)) checkResolvedAddresses(addresses, this.policy);
    const address = addresses[0];
    return { address, family: isIP(address) as 4 | 6 };
  }

  private exchange(
    url: URL,
    target: { address: string; family: 4 | 6 },
    method: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    deadline: number,
    req: EgressRequest,
  ): Promise<Omit<EgressResponse, 'finalUrl' | 'redirects' | 'durationMs'>> {
    return new Promise((resolve, reject) => {
      let sent = false;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      // The vetted address only, whatever the name resolves to now.
      const pinned: LookupFunction = (_host, options, callback) => {
        if ((options as { all?: boolean }).all) {
          (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(
            null,
            [{ address: target.address, family: target.family }],
          );
        } else {
          callback(null, target.address, target.family);
        }
      };
      const options: RequestOptions & { servername?: string } = {
        method,
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: {
          ...headers,
          'accept-encoding': 'gzip, deflate, br',
          ...(body && { 'content-length': String(body.length) }),
        },
        agent: false,
        lookup: pinned,
      };
      if (url.protocol === 'https:' && !isIP(options.hostname as string)) {
        options.servername = options.hostname as string;
      }
      const client = (url.protocol === 'https:' ? httpsRequest : httpRequest)(options);

      const timer = setTimeout(
        () => {
          client.destroy();
          finish(() => reject(new EgressTimeoutError(sent)));
        },
        Math.max(deadline - Date.now(), 1),
      );
      const onAbort = () => {
        client.destroy();
        finish(() => reject(new EgressTimeoutError(sent)));
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });

      client.on('socket', (socket) => {
        const connected = () => {
          sent = true;
        };
        socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', connected);
      });
      client.on('error', (err: NodeJS.ErrnoException) => {
        const code = err.code ?? 'ERROR';
        finish(() => reject(new EgressNetworkError(code, sent ? 'exchange' : 'connect', sent)));
      });
      client.on('response', (res: IncomingMessage) => {
        readCapped(res, req.maxResponseBytes).then(
          ({ body: data, truncated }) =>
            finish(() =>
              resolve({
                status: res.statusCode ?? 0,
                statusText: res.statusMessage ?? '',
                headers: flattenHeaders(res),
                body: data,
                truncated,
              }),
            ),
          (err: NodeJS.ErrnoException) =>
            finish(() => reject(new EgressNetworkError(err.code ?? 'EREAD', 'exchange', true))),
        );
      });
      client.end(body);
    });
  }
}

/** DNS failure that will not fix itself (no such host). */
export const isPermanentDnsError = (err: EgressNetworkError) =>
  err.phase === 'dns' && DNS_PERMANENT.has(err.code);

/** Reads at most `max` bytes of the decoded body; a decompression bomb stops at the cap. */
function readCapped(
  res: IncomingMessage,
  max: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const encoding = String(res.headers['content-encoding'] ?? '')
      .toLowerCase()
      .trim();
    const decoder: Transform | null =
      encoding === 'gzip' || encoding === 'x-gzip'
        ? createGunzip()
        : encoding === 'deflate'
          ? createInflate()
          : encoding === 'br'
            ? createBrotliDecompress()
            : null;
    const stream = decoder ? res.pipe(decoder) : res;
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const end = (truncated: boolean) => {
      if (done) return;
      done = true;
      resolve({ body: Buffer.concat(chunks), truncated });
    };
    stream.on('data', (chunk: Buffer) => {
      if (done) return;
      const room = max - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size = max;
        end(true);
        res.destroy();
        decoder?.destroy();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    stream.on('end', () => end(false));
    stream.on('error', (err) => {
      if (!done) reject(err);
    });
    res.on('error', (err) => {
      if (!done) reject(err);
    });
  });
}

function flattenHeaders(res: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    result[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

function omit(headers: Record<string, string>, names: string[]): Record<string, string> {
  const drop = new Set(names.map((n) => n.toLowerCase()));
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !drop.has(k.toLowerCase())));
}
