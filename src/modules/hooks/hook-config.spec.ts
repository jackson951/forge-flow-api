import { createHmac } from 'node:crypto';
import {
  InboundHookRequest,
  ipAllowed,
  isValidCidr,
  MalformedPayloadError,
  parseHookBody,
  pickHeaders,
  safeEqual,
  sourceDeliveryId,
  verifyHookRequest,
  webhookTriggerConfigSchema,
  WebhookTriggerConfig,
} from './hook-config';

// Assembled at runtime: never a secret-shaped literal in the source.
const SECRET = ['hook', 'test', 'secret', 'value', '0001'].join('-');
const OLD = ['hook', 'test', 'secret', 'value', 'old0'].join('-');
const body = Buffer.from('{"event":{"id":"evt_1","type":"paid"}}');

const config = (overrides: object = {}): WebhookTriggerConfig =>
  webhookTriggerConfigSchema.parse(overrides);
const request = (overrides: Partial<InboundHookRequest> = {}): InboundHookRequest => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  query: {},
  rawBody: body,
  sourceIp: '203.0.113.7',
  ...overrides,
});
const hmac = (alg: string, data: Buffer | string, enc: 'hex' | 'base64' = 'hex', key = SECRET) =>
  createHmac(alg, key).update(data).digest(enc);

describe('generic webhook (Part 24)', () => {
  describe('config (FR-24.7/24.8)', () => {
    it('defaults to POST with token verification', () => {
      expect(config()).toMatchObject({
        methods: ['POST'],
        verification: { mode: 'token', location: 'header', headerName: 'X-FlowForge-Token' },
        ipAllowList: [],
        deduplication: { source: 'none' },
        response: { status: 202 },
        rateLimitPerMinute: 120,
      });
    });

    it('requires an explicit acknowledgement for unverified webhooks', () => {
      expect(webhookTriggerConfigSchema.safeParse({ verification: { mode: 'none' } }).success).toBe(
        false,
      );
      expect(
        webhookTriggerConfigSchema.safeParse({
          verification: { mode: 'none', acknowledgeUnverified: true },
        }).success,
      ).toBe(true);
    });

    it('rejects bad values', () => {
      const bad = [
        { methods: [] },
        { methods: ['POST', 'POST'] },
        { methods: ['DELETE'] },
        { ipAllowList: ['10.0.0.0/33'] },
        { ipAllowList: ['not-an-ip'] },
        { verification: { mode: 'hmac', algorithm: 'md5' } },
        { verification: { mode: 'basic', username: 'a:b' } },
        { response: { status: 201 } },
        { response: { body: { big: 'x'.repeat(2_000) } } },
        { deduplication: { source: 'body', path: 'a..b' } },
        { rateLimitPerMinute: 0 },
        { unknown: true },
      ];
      for (const value of bad) {
        expect([value, webhookTriggerConfigSchema.safeParse(value).success]).toEqual([
          value,
          false,
        ]);
      }
    });

    it('accepts a filter in the condition grammar', () => {
      const filter = {
        all: [
          {
            left: { ref: 'trigger.body.event.type' },
            operator: 'equals',
            right: { value: 'paid' },
          },
        ],
      };
      expect(webhookTriggerConfigSchema.safeParse({ filter }).success).toBe(true);
    });
  });

  describe('verification (FR-24.8, FR-24.9)', () => {
    it('token in a header or as a bearer token; previous secret accepted during grace', () => {
      const header = config();
      expect(
        verifyHookRequest(header, request({ headers: { 'x-flowforge-token': SECRET } }), [SECRET]),
      ).toEqual({ ok: true });
      expect(
        verifyHookRequest(header, request({ headers: { 'x-flowforge-token': 'nope' } }), [SECRET]),
      ).toEqual({
        ok: false,
        reason: 'token mismatch',
      });
      expect(verifyHookRequest(header, request(), [SECRET])).toMatchObject({
        ok: false,
        reason: 'token missing',
      });
      expect(
        verifyHookRequest(header, request({ headers: { 'x-flowforge-token': OLD } }), [
          SECRET,
          OLD,
        ]),
      ).toEqual({ ok: true });
      const bearer = config({ verification: { mode: 'token', location: 'bearer' } });
      expect(
        verifyHookRequest(bearer, request({ headers: { authorization: `Bearer ${SECRET}` } }), [
          SECRET,
        ]),
      ).toEqual({ ok: true });
      expect(verifyHookRequest(header, request(), [])).toMatchObject({
        ok: false,
        reason: 'no secret configured',
      });
    });

    it('basic authentication', () => {
      const basic = config({ verification: { mode: 'basic', username: 'sender' } });
      const auth = (u: string, p: string) => ({
        authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`,
      });
      expect(
        verifyHookRequest(basic, request({ headers: auth('sender', SECRET) }), [SECRET]),
      ).toEqual({ ok: true });
      expect(
        verifyHookRequest(basic, request({ headers: auth('other', SECRET) }), [SECRET]).ok,
      ).toBe(false);
      expect(
        verifyHookRequest(basic, request({ headers: auth('sender', 'wrong') }), [SECRET]).ok,
      ).toBe(false);
      expect(verifyHookRequest(basic, request(), [SECRET]).ok).toBe(false);
    });

    it.each([
      ['sha256', 'hex', ''],
      ['sha256', 'hex', 'sha256='],
      ['sha1', 'hex', 'sha1='],
      ['sha512', 'base64', ''],
      ['sha256', 'base64', 'v1,'],
    ] as const)('HMAC %s %s with prefix "%s" over the raw body', (algorithm, encoding, prefix) => {
      const c = config({ verification: { mode: 'hmac', algorithm, encoding, prefix } });
      const signature = prefix + hmac(algorithm, body, encoding);
      expect(
        verifyHookRequest(c, request({ headers: { 'x-flowforge-signature': signature } }), [
          SECRET,
        ]),
      ).toEqual({ ok: true });
      // One changed byte in the body fails.
      const tampered = Buffer.from(body.toString().replace('paid', 'free'));
      expect(
        verifyHookRequest(
          c,
          request({ rawBody: tampered, headers: { 'x-flowforge-signature': signature } }),
          [SECRET],
        ),
      ).toMatchObject({ ok: false, reason: 'signature mismatch' });
    });

    it('timestamped HMAC inside / outside the replay window, both formats', () => {
      const now = 1_800_000_000_000;
      const ts = String(now / 1_000);
      for (const format of ['{timestamp}.{body}', 'v0:{timestamp}:{body}'] as const) {
        const c = config({
          verification: {
            mode: 'hmac',
            headerName: 'X-Signature',
            prefix: format.startsWith('v0') ? 'v0=' : '',
            timestamp: { headerName: 'X-Timestamp', toleranceSeconds: 300, format },
          },
        });
        const signed = format.startsWith('v0') ? `v0:${ts}:${body}` : `${ts}.${body}`;
        const headers = {
          'x-signature': `${format.startsWith('v0') ? 'v0=' : ''}${hmac('sha256', signed)}`,
          'x-timestamp': ts,
        };
        expect(verifyHookRequest(c, request({ headers }), [SECRET], now)).toEqual({ ok: true });
        expect(verifyHookRequest(c, request({ headers }), [SECRET], now + 301_000)).toMatchObject({
          ok: false,
          reason: 'timestamp outside the replay window',
        });
        // A valid signature with a forged timestamp fails.
        expect(
          verifyHookRequest(
            c,
            request({ headers: { ...headers, 'x-timestamp': String(Number(ts) + 10) } }),
            [SECRET],
            now,
          ),
        ).toMatchObject({ ok: false });
        expect(
          verifyHookRequest(
            c,
            request({ headers: { 'x-signature': headers['x-signature'] } }),
            [SECRET],
            now,
          ),
        ).toMatchObject({
          ok: false,
          reason: 'timestamp missing',
        });
      }
    });

    it('IP allow-list applies on top of any mode', () => {
      const c = config({ ipAllowList: ['198.51.100.0/24', '2001:db8::/32', '203.0.113.9'] });
      const headers = { 'x-flowforge-token': SECRET };
      expect(
        verifyHookRequest(c, request({ headers, sourceIp: '198.51.100.20' }), [SECRET]),
      ).toEqual({ ok: true });
      expect(
        verifyHookRequest(c, request({ headers, sourceIp: '::ffff:198.51.100.20' }), [SECRET]),
      ).toEqual({ ok: true });
      expect(verifyHookRequest(c, request({ headers, sourceIp: '2001:db8::1' }), [SECRET])).toEqual(
        { ok: true },
      );
      expect(
        verifyHookRequest(c, request({ headers, sourceIp: '203.0.113.7' }), [SECRET]),
      ).toMatchObject({
        ok: false,
        reason: 'source IP not in the allow-list',
      });
      expect(ipAllowed('garbage', ['0.0.0.0/0'])).toBe(false);
      expect(isValidCidr('10.0.0.0/8')).toBe(true);
      expect(isValidCidr('::1/129')).toBe(false);
    });

    it('compares in constant time and exactly', () => {
      expect(safeEqual('abc', 'abc')).toBe(true);
      expect(safeEqual('abc', 'abd')).toBe(false);
      expect(safeEqual('abc', 'abcd')).toBe(false);
    });
  });

  describe('payload (FR-24.10/24.11)', () => {
    it('parses JSON, form and text; keeps other types as raw text', () => {
      expect(parseHookBody(body, 'application/json; charset=utf-8')).toEqual({
        body: { event: { id: 'evt_1', type: 'paid' } },
        contentType: 'application/json',
      });
      expect(
        parseHookBody(Buffer.from('a=1&b=2&a=3'), 'application/x-www-form-urlencoded').body,
      ).toEqual({
        a: ['1', '3'],
        b: '2',
      });
      expect(parseHookBody(Buffer.from('hello'), 'text/plain').body).toBe('hello');
      expect(parseHookBody(Buffer.from('<a/>'), 'application/xml')).toEqual({
        body: null,
        rawText: '<a/>',
        contentType: 'application/xml',
      });
      expect(parseHookBody(Buffer.alloc(0), 'application/json').body).toBeNull();
      expect(() => parseHookBody(Buffer.from('{bad'), 'application/json')).toThrow(
        MalformedPayloadError,
      );
    });

    it('keeps allow-listed headers and never credentials or signatures', () => {
      const c = config({
        verification: { mode: 'hmac', headerName: 'X-Sig' },
        includeHeaders: ['X-Shop-Domain', 'Authorization'],
      });
      expect(
        pickHeaders(
          {
            'content-type': 'application/json',
            'x-shop-domain': 'acme',
            authorization: 'Bearer abc',
            'x-sig': 'deadbeef',
            cookie: 'a=b',
            'x-github-event': 'push',
            'x-unlisted': 'no',
          },
          c,
        ),
      ).toEqual({
        'content-type': 'application/json',
        'x-shop-domain': 'acme',
        'x-github-event': 'push',
      });
    });

    it('takes the delivery id from a header or a JSON path', () => {
      const parsed = JSON.parse(body.toString());
      expect(
        sourceDeliveryId(
          config({ deduplication: { source: 'header', header: 'Idempotency-Key' } }),
          { 'idempotency-key': 'k-1' },
          parsed,
        ),
      ).toBe('k-1');
      expect(
        sourceDeliveryId(
          config({ deduplication: { source: 'body', path: 'event.id' } }),
          {},
          parsed,
        ),
      ).toBe('evt_1');
      expect(
        sourceDeliveryId(
          config({ deduplication: { source: 'body', path: 'event.missing' } }),
          {},
          parsed,
        ),
      ).toBeUndefined();
      expect(sourceDeliveryId(config(), { 'idempotency-key': 'k-1' }, parsed)).toBeUndefined();
      expect(
        sourceDeliveryId(config({ deduplication: { source: 'body', path: 'n' } }), {}, { n: 42 }),
      ).toBe('42');
      expect(
        sourceDeliveryId(
          config({ deduplication: { source: 'body', path: 'n' } }),
          {},
          { n: 'x'.repeat(201) },
        ),
      ).toBeUndefined();
    });
  });
});
