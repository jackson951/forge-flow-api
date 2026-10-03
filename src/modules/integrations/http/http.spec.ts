import { ErrorCategory } from '@prisma/client';
import { PermanentError, RetryableError } from '../../../engine/errors';
import {
  EgressNetworkError,
  EgressResponse,
  EgressTimeoutError,
} from '../../../infrastructure/egress/egress-client';
import { EgressBlockedError, EgressPolicy } from '../../../infrastructure/egress/egress-policy';
import { applyAuth, httpCredentialsSchema, splitCredentials } from './http-auth';
import {
  buildBody,
  classifyStatus,
  classifyTransportError,
  normalizeResponse,
  NormalizeOptions,
  parseRetryAfter,
  resolveRequestUrl,
  scrubSecrets,
} from './http-request';
import { httpNodeTypes, httpRequestConfigSchema } from './http.node-types';

const policy: EgressPolicy = {
  allowPlainHttp: false,
  allowPrivateNetworks: false,
  deniedPorts: [25],
  deniedHosts: [],
};
const schema = httpRequestConfigSchema(policy);
const messages = (config: object) => {
  const r = schema.safeParse(config);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};
// Assembled at runtime so no secret-shaped literal sits in the source.
const SECRET = ['s3cr3t', 'value', 'for', 'tests', 'only'].join('-');

describe('HTTP action (Part 24)', () => {
  describe('config (FR-24.1/24.2)', () => {
    it('applies defaults', () => {
      expect(schema.parse({ url: 'https://api.example.com/x' })).toEqual({
        method: 'GET',
        url: 'https://api.example.com/x',
        query: {},
        headers: {},
        body: { type: 'none' },
        timeoutMs: 10_000,
        followRedirects: true,
        responseType: 'auto',
        failOn4xx: true,
        idempotent: false,
        onLargeResponse: 'truncate',
      });
    });

    it('accepts templates and every body type', () => {
      for (const body of [
        { type: 'json', value: { id: '{{ trigger.id }}', n: { ref: 'trigger.n' } } },
        { type: 'text', value: 'hello {{ trigger.name }}' },
        { type: 'form', value: { a: '1' } },
      ]) {
        expect(messages({ method: 'POST', url: 'https://{{ trigger.host }}/x', body })).toEqual([]);
      }
    });

    it('refuses credentials and reserved headers in plain config', () => {
      for (const name of ['Authorization', 'Cookie', 'X-Api-Key', 'proxy-authorization']) {
        expect(messages({ url: 'https://a.example/', headers: { [name]: 'x' } })).toEqual([
          expect.stringContaining('use an HTTP connection'),
        ]);
      }
      for (const name of ['Host', 'Content-Length', 'Transfer-Encoding', 'Connection']) {
        expect(messages({ url: 'https://a.example/', headers: { [name]: 'x' } })).toEqual([
          expect.stringContaining('set by FlowForge'),
        ]);
      }
      expect(
        messages({ url: 'https://a.example/', headers: { 'X-A': 'a\r\nInjected: 1' } }),
      ).toEqual([expect.stringContaining('line breaks')]);
      expect(messages({ url: 'https://a.example/', headers: { 'bad name': 'x' } })).toHaveLength(1);
    });

    it('checks static URLs against the egress policy at validation time', () => {
      expect(messages({ url: 'http://api.example.com/' })).toEqual([
        'url: Destination not allowed: only https is allowed',
      ]);
      expect(messages({ url: 'https://169.254.169.254/latest/meta-data/' })).toEqual([
        'url: Destination not allowed: private, loopback or reserved address',
      ]);
      expect(messages({ url: 'https://localhost/' })).toEqual([
        'url: Destination not allowed: internal host name',
      ]);
      expect(messages({ url: '/relative' })).toEqual([
        'url: Use an absolute URL (https://…), or a connection with a base URL',
      ]);
      expect(
        messages({ url: '/relative', connectionId: '6f2b8c1e-1d1a-4c3b-9a7e-2b1c3d4e5f60' }),
      ).toEqual([]);
    });

    it('rejects bodies on GET/HEAD and out-of-range options', () => {
      expect(messages({ url: 'https://a.example/', body: { type: 'text', value: 'x' } })).toEqual([
        'body: GET requests cannot have a body',
      ]);
      expect(messages({ url: 'https://a.example/', timeoutMs: 60_000 })).toHaveLength(1);
      expect(messages({ url: 'https://a.example/', method: 'TRACE' })).toHaveLength(1);
      expect(messages({ url: 'https://a.example/', password: 'x' })).toHaveLength(1); // strict
    });

    it('the node type uses an optional HTTP connection and can be disabled', () => {
      expect(httpNodeTypes(policy, true)[0]).toMatchObject({
        type: 'http.request',
        connectionProvider: 'HTTP',
        connectionOptional: true,
      });
      expect(httpNodeTypes(policy, false)[0].unavailableReason).toMatch(/disabled/);
    });
  });

  describe('connections (FR-24.4)', () => {
    it('validates credentials per auth type', () => {
      expect(httpCredentialsSchema.safeParse({ authType: 'bearer', token: SECRET }).success).toBe(
        true,
      );
      expect(httpCredentialsSchema.safeParse({ authType: 'bearer' }).success).toBe(false);
      expect(
        httpCredentialsSchema.safeParse({ authType: 'basic', username: 'a:b', password: SECRET })
          .success,
      ).toBe(false);
      expect(
        httpCredentialsSchema.safeParse({
          authType: 'apiKeyHeader',
          headerName: 'Host',
          value: SECRET,
        }).success,
      ).toBe(false);
      expect(
        httpCredentialsSchema.safeParse({ authType: 'customHeaders', headers: {} }).success,
      ).toBe(false);
      expect(httpCredentialsSchema.safeParse({ authType: 'bearer', token: `a\r\nb` }).success).toBe(
        false,
      );
    });

    it('splits secrets from visible metadata (hint only)', () => {
      const { secrets, metadata } = splitCredentials({
        authType: 'apiKeyHeader',
        headerName: 'X-Api-Key',
        value: SECRET,
      });
      expect(secrets).toEqual({ value: SECRET });
      expect(metadata).toEqual({
        authType: 'apiKeyHeader',
        headerName: 'X-Api-Key',
        secretHint: `…${SECRET.slice(-4)}`,
      });
      expect(JSON.stringify(metadata)).not.toContain(SECRET.slice(0, 8));
      expect(splitCredentials({ authType: 'bearer', token: 'short' }).metadata.secretHint).toBe(
        '…',
      );
    });

    it('applies every auth type and reports the sensitive header names', () => {
      const url = new URL('https://api.example.com/x?a=1');
      const bearer = splitCredentials({ authType: 'bearer', token: SECRET });
      expect(applyAuth(bearer.metadata, bearer.secrets, url, {})).toMatchObject({
        headers: { authorization: `Bearer ${SECRET}` },
        sensitiveHeaders: ['authorization'],
      });
      const basic = splitCredentials({ authType: 'basic', username: 'u', password: 'p' });
      expect(applyAuth(basic.metadata, basic.secrets, url, {}).headers.authorization).toBe(
        `Basic ${Buffer.from('u:p').toString('base64')}`,
      );
      const query = splitCredentials({
        authType: 'apiKeyQuery',
        paramName: 'api_key',
        value: SECRET,
      });
      const applied = applyAuth(query.metadata, query.secrets, url, {});
      expect(applied.url.searchParams.get('api_key')).toBe(SECRET);
      expect(applied.secretParam).toBe('api_key');
      expect(url.searchParams.get('api_key')).toBeNull(); // input URL untouched
      const custom = splitCredentials({
        authType: 'customHeaders',
        headers: { 'X-One': 'a', 'X-Two': 'b' },
      });
      expect(applyAuth(custom.metadata, custom.secrets, url, {})).toMatchObject({
        headers: { 'x-one': 'a', 'x-two': 'b' },
        sensitiveHeaders: ['x-one', 'x-two'],
      });
    });
  });

  describe('requests', () => {
    it('resolves relative URLs against the connection base URL', () => {
      expect(resolveRequestUrl('items', 'https://api.example.com/v1').toString()).toBe(
        'https://api.example.com/v1/items',
      );
      expect(resolveRequestUrl('/items?x=1', 'https://api.example.com/v1/').toString()).toBe(
        'https://api.example.com/v1/items?x=1',
      );
      expect(resolveRequestUrl('https://other.example/a', 'https://api.example.com').host).toBe(
        'other.example',
      );
      expect(() => resolveRequestUrl('items')).toThrow(PermanentError);
    });

    it('builds JSON, text and form bodies with a 1 MB cap', () => {
      expect(buildBody({ type: 'none' })).toEqual({});
      expect(buildBody({ type: 'json', value: { a: 1 } })).toEqual({
        data: Buffer.from('{"a":1}'),
        contentType: 'application/json',
      });
      expect(buildBody({ type: 'form', value: { a: 'x y', b: '&' } }).data?.toString()).toBe(
        'a=x+y&b=%26',
      );
      expect(() => buildBody({ type: 'text', value: 'x'.repeat(1_048_577) })).toThrow(
        /exceeds 1 MB/,
      );
    });

    it('parses Retry-After seconds and dates, capped at an hour', () => {
      expect(parseRetryAfter('30')).toBe(30_000);
      expect(parseRetryAfter(new Date(1_000_000 + 5_000).toUTCString(), 1_000_000)).toBeGreaterThan(
        0,
      );
      expect(parseRetryAfter('999999')).toBe(3_600_000);
      expect(parseRetryAfter('soon')).toBeUndefined();
      expect(parseRetryAfter(undefined)).toBeUndefined();
    });
  });

  describe('error classification (FR-24.5, AC-24.3)', () => {
    const res = (status: number, headers: Record<string, string> = {}) => ({
      status,
      statusText: '',
      headers,
    });
    const cls = (status: number, idempotent = true, failOn4xx = true, headers = {}) =>
      classifyStatus(res(status, headers), { idempotent, failOn4xx });

    it('success and redirects are not errors', () => {
      expect(cls(200)).toBeNull();
      expect(cls(304)).toBeNull();
    });

    it('maps statuses per the table', () => {
      expect(cls(401)).toMatchObject({ category: ErrorCategory.PROVIDER_AUTH, retryable: false });
      expect(cls(403)).toMatchObject({ category: ErrorCategory.PROVIDER_AUTH });
      expect(cls(404)).toMatchObject({
        category: ErrorCategory.PERMANENT_PROVIDER_ERROR,
        retryable: false,
      });
      expect(cls(422)).toMatchObject({ category: ErrorCategory.PERMANENT_PROVIDER_ERROR });
      expect(cls(429, false, true, { 'retry-after': '7' })).toMatchObject({
        category: ErrorCategory.PROVIDER_RATE_LIMIT,
        retryable: true,
        retryAfterMs: 7_000,
      });
      expect(cls(503, false, true, { 'retry-after': '2' })).toMatchObject({
        category: ErrorCategory.TRANSIENT_INFRASTRUCTURE,
        retryable: true,
        retryAfterMs: 2_000,
      });
      expect(cls(500, true)).toBeInstanceOf(RetryableError);
      for (const status of [500, 502, 504]) {
        expect(cls(status, false)).toMatchObject({
          category: ErrorCategory.UNCERTAIN_OUTCOME,
          retryable: false,
        });
      }
    });

    it('failOn4xx off returns 4xx responses as output', () => {
      expect(cls(404, true, false)).toBeNull();
      expect(cls(500, true, false)).toBeInstanceOf(RetryableError);
    });

    it('maps transport failures, with sent non-idempotent requests as uncertain', () => {
      expect(classifyTransportError(new EgressBlockedError('x'), true)).toMatchObject({
        category: ErrorCategory.VALIDATION,
        retryable: false,
      });
      expect(
        classifyTransportError(new EgressNetworkError('ENOTFOUND', 'dns', false), true),
      ).toMatchObject({
        category: ErrorCategory.PERMANENT_PROVIDER_ERROR,
      });
      expect(
        classifyTransportError(new EgressNetworkError('EAI_AGAIN', 'dns', false), false),
      ).toMatchObject({
        category: ErrorCategory.TRANSIENT_INFRASTRUCTURE,
        retryable: true,
      });
      expect(
        classifyTransportError(new EgressNetworkError('ECONNREFUSED', 'connect', false), false),
      ).toMatchObject({
        category: ErrorCategory.TRANSIENT_INFRASTRUCTURE,
        retryable: true,
      });
      expect(
        classifyTransportError(new EgressNetworkError('ECONNRESET', 'exchange', true), false),
      ).toMatchObject({
        category: ErrorCategory.UNCERTAIN_OUTCOME,
      });
      expect(
        classifyTransportError(new EgressNetworkError('ECONNRESET', 'exchange', true), true),
      ).toMatchObject({
        category: ErrorCategory.TRANSIENT_INFRASTRUCTURE,
        retryable: true,
      });
      expect(classifyTransportError(new EgressTimeoutError(true), false)).toMatchObject({
        category: ErrorCategory.UNCERTAIN_OUTCOME,
      });
      expect(classifyTransportError(new EgressTimeoutError(true), true)).toMatchObject({
        category: ErrorCategory.PROVIDER_TIMEOUT,
        retryable: true,
      });
      expect(classifyTransportError(new Error('boom'), true)).toMatchObject({
        category: ErrorCategory.INTERNAL,
      });
    });
  });

  describe('normalised output (FR-24.3)', () => {
    const response = (overrides: Partial<EgressResponse> = {}): EgressResponse => ({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"ticketId":42}'),
      truncated: false,
      finalUrl: new URL('https://api.example.com/t'),
      redirects: 0,
      durationMs: 12,
      ...overrides,
    });
    const opts = (o: Partial<NormalizeOptions> = {}): NormalizeOptions => ({
      responseType: 'auto',
      method: 'GET',
      maxStoredBodyBytes: 1_000,
      onLargeResponse: 'truncate',
      sensitiveHeaders: [],
      ...o,
    });

    it('parses JSON and keeps status, headers, timing and the final URL', () => {
      expect(normalizeResponse(response(), opts())).toEqual({
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: { ticketId: 42 },
        durationMs: 12,
        finalUrl: 'https://api.example.com/t',
      });
    });

    it('drops cookies, credential headers and the credential query param', () => {
      const out = normalizeResponse(
        response({
          headers: { 'set-cookie': 'sid=1', 'x-api-key': SECRET, etag: 'e' },
          finalUrl: new URL(`https://api.example.com/t?api_key=${SECRET}&page=2`),
        }),
        opts({ sensitiveHeaders: ['x-api-key'], secretParam: 'api_key' }),
      );
      expect(out.headers).toEqual({ etag: 'e' });
      expect(out.finalUrl).toBe('https://api.example.com/t?page=2');
      expect(JSON.stringify(out)).not.toContain(SECRET);
    });

    it('falls back to text in auto mode; fails in json mode on invalid JSON', () => {
      const bad = response({ body: Buffer.from('<html>') });
      expect(normalizeResponse(bad, opts()).body).toBe('<html>');
      expect(() => normalizeResponse(bad, opts({ responseType: 'json' }))).toThrow(
        /not valid JSON/,
      );
      expect(normalizeResponse(response({ headers: {} }), opts()).body).toBe('{"ticketId":42}');
      expect(normalizeResponse(response(), opts({ method: 'HEAD' })).body).toBeNull();
    });

    it('truncates or fails on large bodies, by option', () => {
      const big = response({
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('é'.repeat(2_000)),
      });
      const out = normalizeResponse(big, opts());
      expect(out.bodyTruncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(out.body))).toBeLessThanOrEqual(1_000);
      expect(out.body as string).not.toMatch(/�/);
      expect(() => normalizeResponse(big, opts({ onLargeResponse: 'error' }))).toThrow(
        /RESPONSE_TOO_LARGE/,
      );
      const cut = response({ truncated: true });
      expect(normalizeResponse(cut, opts()).bodyTruncated).toBe(true);
      expect(() => normalizeResponse(cut, opts({ responseType: 'json' }))).toThrow(
        /RESPONSE_TOO_LARGE/,
      );
    });
  });

  it('scrubs the connection secrets from output, plain and URL-encoded (servers echo requests)', () => {
    const odd = `${SECRET}+/=`;
    const out = scrubSecrets(
      {
        body: { url: `/x?api_key=${encodeURIComponent(odd)}`, note: `key ${SECRET}`, [SECRET]: 1 },
        list: [`form=${new URLSearchParams({ a: odd }).toString()}`],
        n: 5,
      },
      [odd, SECRET, 'abc'],
    );
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.body.note).toBe('key [REDACTED]');
    expect(out.n).toBe(5);
    expect(scrubSecrets('abc stays', ['abc'])).toBe('abc stays'); // too short to scrub safely
  });
});
