import { createHmac } from 'node:crypto';
import { AppConfigService } from '../../../config/app-config.service';
import { TestWebhookProvider } from './test-webhook.provider';
import { hmacSha256Matches, InboundWebhook } from './webhook-provider';

const SECRET = 'unit-test-webhook-secret';

function provider(opts: { production?: boolean; secret?: string } = {}) {
  const config = {
    isProduction: opts.production ?? false,
    get: (key: string) => (key === 'WEBHOOK_TEST_SECRET' ? (opts.secret ?? SECRET) : undefined),
  } as unknown as AppConfigService;
  return new TestWebhookProvider(config);
}

function request(
  body: object,
  opts: {
    timestamp?: number;
    secret?: string;
    tamper?: boolean;
    headers?: Record<string, string>;
  } = {},
): InboundWebhook {
  const raw = Buffer.from(JSON.stringify(body));
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', opts.secret ?? SECRET)
    .update(`${ts}.${raw.toString()}`)
    .digest('hex');
  return {
    rawBody: opts.tamper ? Buffer.from(JSON.stringify({ ...body, injected: true })) : raw,
    body,
    headers: {
      'x-flowforge-timestamp': String(ts),
      'x-flowforge-signature': `sha256=${sig}`,
      'x-flowforge-delivery': 'd-1',
      'x-flowforge-event': 'thing.created',
      ...opts.headers,
    },
  };
}

describe('TestWebhookProvider', () => {
  const p = provider();
  const body = { resource: 'res-1', data: { title: 'Hello' } };

  it('is only enabled outside production and with a secret', () => {
    expect(p.isEnabled()).toBe(true);
    expect(provider({ production: true }).isEnabled()).toBe(false);
    expect(provider({ secret: '' }).isEnabled()).toBe(false);
  });

  it('accepts a correctly signed, fresh delivery', () => {
    expect(p.verify(request(body))).toEqual({ ok: true });
  });

  it.each([
    ['wrong secret', request(body, { secret: 'another-secret-value' }), 'signature mismatch'],
    ['tampered body', request(body, { tamper: true }), 'signature mismatch'],
    [
      'stale timestamp',
      request(body, { timestamp: Math.floor(Date.now() / 1000) - 600 }),
      'replay window',
    ],
    [
      'future timestamp',
      request(body, { timestamp: Math.floor(Date.now() / 1000) + 600 }),
      'replay window',
    ],
    [
      'missing signature',
      request(body, { headers: { 'x-flowforge-signature': '' } }),
      'signature mismatch',
    ],
    [
      'missing timestamp',
      request(body, { headers: { 'x-flowforge-timestamp': 'nope' } }),
      'missing timestamp',
    ],
  ])('rejects %s', (_label, req, reason) => {
    expect(p.verify(req)).toEqual({ ok: false, reason: expect.stringContaining(reason) });
  });

  it('normalises the event', () => {
    expect(p.normalize(request(body))).toEqual({
      eventType: 'thing.created',
      resourceKey: 'res-1',
      data: { title: 'Hello' },
    });
    expect(p.deliveryId(request(body))).toBe('d-1');
  });

  it('ignores payloads without a resource', () => {
    expect(p.normalize(request({ data: {} }))).toBeNull();
  });
});

describe('hmacSha256Matches', () => {
  const sig = `sha256=${createHmac('sha256', 's').update('payload').digest('hex')}`;
  it('matches only the exact signature', () => {
    expect(hmacSha256Matches('s', 'payload', sig)).toBe(true);
    expect(hmacSha256Matches('s', 'payload', sig.slice(0, -1) + '0')).toBe(false);
    expect(hmacSha256Matches('s', 'payload', sig.slice(0, -2))).toBe(false);
    expect(hmacSha256Matches('s', 'payload', undefined)).toBe(false);
    expect(hmacSha256Matches('s', 'payload', sig.replace('sha256=', 'sha1='))).toBe(false);
  });
});
