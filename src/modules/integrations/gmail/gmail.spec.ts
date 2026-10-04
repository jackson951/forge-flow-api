import { ErrorCategory } from '@prisma/client';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { AppConfigService } from '../../../config/app-config.service';
import { passes } from '../../../execution/gmail-sync.service';
import {
  GmailUnauthorizedError,
  mapGmailError,
  mapTokenError,
  GmailConsentError,
} from './gmail-client';
import {
  buildRawEmail,
  emailOutput,
  encodeHeaderText,
  EmailValidationError,
  htmlToText,
  normalizeMessage,
  parseAddresses,
  replySubject,
} from './gmail-mime';
import { GmailPushProvider } from './gmail-push.provider';
import { gmailNodeTypes } from './gmail.node-types';
import { GoogleOidcVerifier } from './google-oidc-verifier';

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const decodeRaw = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

describe('Gmail (Part 26)', () => {
  describe('MIME building (FR-26.9)', () => {
    it('validates addresses and rejects header injection', () => {
      expect(parseAddresses('a@example.com, "Ada L." <ada@example.org>', 'To')).toEqual([
        'a@example.com',
        'Ada L. <ada@example.org>',
      ]);
      expect(parseAddresses('', 'Cc')).toEqual([]);
      expect(() => parseAddresses('not-an-address', 'To')).toThrow(EmailValidationError);
      expect(() => parseAddresses('a@example.com\r\nBcc: victim@example.com', 'To')).toThrow(
        /line breaks/,
      );
      expect(() =>
        parseAddresses(Array.from({ length: 51 }, (_, i) => `u${i}@example.com`).join(','), 'To'),
      ).toThrow(/At most 50/);
      expect(() => encodeHeaderText('Hi\nBcc: x@y.z')).toThrow(EmailValidationError);
    });

    it('encodes non-ASCII headers (RFC 2047) and builds text and HTML parts', () => {
      expect(encodeHeaderText('Plain')).toBe('Plain');
      expect(encodeHeaderText('Grüße')).toBe(
        `=?UTF-8?B?${Buffer.from('Grüße').toString('base64')}?=`,
      );
      const raw = decodeRaw(
        buildRawEmail({
          from: 'me@example.com',
          to: ['you@example.com'],
          cc: ['cc@example.com'],
          bcc: ['hidden@example.com'],
          subject: 'Report ✓',
          text: 'Hello\nworld',
          html: '<p>Hello</p>',
          inReplyTo: '<orig@mail>',
          references: '<root@mail> <orig@mail>',
        }),
      );
      expect(raw).toContain('From: me@example.com\r\n');
      expect(raw).toContain('To: you@example.com\r\n');
      expect(raw).toContain('Bcc: hidden@example.com\r\n');
      expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from('Report ✓').toString('base64')}?=`);
      expect(raw).toContain('In-Reply-To: <orig@mail>');
      expect(raw).toContain('Content-Type: multipart/alternative; boundary="ff-');
      expect(raw).toContain(Buffer.from('Hello\nworld').toString('base64'));
      expect(raw).toContain('Content-Type: text/html; charset="UTF-8"');
      expect(() =>
        buildRawEmail({ from: 'me@example.com', to: [], subject: 's', text: 't' }),
      ).toThrow(/recipient/);
    });

    it('prefixes Re: once', () => {
      expect(replySubject('Invoice')).toBe('Re: Invoice');
      expect(replySubject('RE: Invoice')).toBe('RE: Invoice');
    });
  });

  describe('reading messages (FR-26.8)', () => {
    const message = (payload: object, extra: object = {}) => ({
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX', 'UNREAD'],
      snippet: 'Hello there',
      internalDate: '1800000000000',
      payload,
      ...extra,
    });
    const headers = [
      { name: 'From', value: 'Ada <ada@example.org>' },
      { name: 'To', value: 'support@example.com' },
      { name: 'Subject', value: 'Login broken' },
      { name: 'Message-ID', value: '<orig@mail>' },
    ];

    it('prefers text/plain, converts HTML to text, names attachments without reading them', () => {
      const m = normalizeMessage(
        message({
          mimeType: 'multipart/mixed',
          headers,
          parts: [
            {
              mimeType: 'multipart/alternative',
              parts: [
                { mimeType: 'text/plain', body: { data: b64url('Plain body') } },
                { mimeType: 'text/html', body: { data: b64url('<p>HTML body</p>') } },
              ],
            },
            {
              mimeType: 'application/pdf',
              filename: 'invoice.pdf',
              body: { attachmentId: 'att-1', size: 1234 },
            },
          ],
        }),
        'support@example.com',
        1_000,
      );
      expect(m).toMatchObject({
        messageId: 'm1',
        threadId: 't1',
        from: 'Ada <ada@example.org>',
        subject: 'Login broken',
        textBody: 'Plain body',
        hasAttachments: true,
        attachmentNames: ['invoice.pdf'],
        date: new Date(1_800_000_000_000).toISOString(),
        mailbox: 'support@example.com',
        rfcMessageId: '<orig@mail>',
      });
      expect(JSON.stringify(m)).not.toContain('att-1');
      expect(emailOutput(m)).not.toHaveProperty('rfcMessageId');
    });

    it('uses HTML when there is no text part, and caps the body', () => {
      const html =
        '<html><head><style>x{}</style></head><body><p>Hi &amp; welcome</p><script>evil()</script><div>Line two</div></body></html>';
      expect(htmlToText(html)).toBe('Hi & welcome\nLine two');
      const m = normalizeMessage(
        message({
          mimeType: 'text/html',
          headers,
          body: { data: b64url('<p>' + 'x'.repeat(5_000) + '</p>') },
        }),
        'me@x.co',
        1_000,
      );
      expect(m.textBody).toHaveLength(1_000);
      expect(m.textTruncated).toBe(true);
    });
  });

  describe('errors (Part 26 error table)', () => {
    const h = (v: Record<string, string> = {}) => new Headers(v);
    const reason = (r: string) => ({ error: { errors: [{ reason: r }] } });
    it('maps Gmail statuses', () => {
      expect(mapGmailError(401, h(), {}, false)).toBeInstanceOf(GmailUnauthorizedError);
      expect(mapGmailError(403, h(), reason('insufficientPermissions'), false)).toMatchObject({
        category: ErrorCategory.PROVIDER_AUTH,
      });
      expect(mapGmailError(403, h(), reason('userRateLimitExceeded'), false)).toMatchObject({
        category: ErrorCategory.PROVIDER_RATE_LIMIT,
        retryable: true,
      });
      expect(mapGmailError(429, h({ 'retry-after': '5' }), {}, true)).toMatchObject({
        retryAfterMs: 5_000,
      });
      expect(mapGmailError(404, h(), reason('notFound'), false).message).toMatch(
        /^Gmail: not found/,
      );
      expect(mapGmailError(500, h(), {}, false)).toMatchObject({ retryable: true });
      expect(mapGmailError(500, h(), {}, true)).toMatchObject({
        category: ErrorCategory.UNCERTAIN_OUTCOME,
      });
      expect(mapGmailError(503, h(), {}, true)).toMatchObject({ retryable: true });
      expect(mapTokenError(400, { error: 'invalid_grant' })).toBeInstanceOf(GmailConsentError);
      expect(mapTokenError(401, { error: 'invalid_client' }).message).toMatch(/OAuth client/);
    });
  });

  describe('push verification (FR-26.5)', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
    const config = {
      gmail: {
        pushAudience: 'https://api.example.com/api/v1/webhooks/gmail',
        pushServiceAccount: 'push@proj.iam.gserviceaccount.com',
        jwksUrl: 'https://keys.test/certs',
      },
    } as unknown as AppConfigService;
    const sign = (claims: object, header: object = { alg: 'RS256', kid: 'k1', typ: 'JWT' }) => {
      const head = b64url(JSON.stringify(header));
      const body = b64url(JSON.stringify(claims));
      const sig = createSign('RSA-SHA256')
        .update(`${head}.${body}`)
        .sign(privateKey)
        .toString('base64url');
      return `Bearer ${head}.${body}.${sig}`;
    };
    const now = 1_800_000_000_000;
    const good = {
      iss: 'https://accounts.google.com',
      aud: 'https://api.example.com/api/v1/webhooks/gmail',
      email: 'push@proj.iam.gserviceaccount.com',
      email_verified: true,
      iat: now / 1_000 - 10,
      exp: now / 1_000 + 3_000,
    };
    let fetchSpy: jest.SpyInstance;
    beforeEach(() => {
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ keys: [jwk] })));
    });
    afterEach(() => fetchSpy.mockRestore());

    it('accepts a valid Pub/Sub OIDC token and caches the keys', async () => {
      const verifier = new GoogleOidcVerifier(config);
      expect(await verifier.verify(sign(good), now)).toEqual({ ok: true });
      expect(await verifier.verify(sign(good), now)).toEqual({ ok: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['issuer', { ...good, iss: 'https://evil.example' }, 'unexpected issuer'],
      ['audience', { ...good, aud: 'https://other' }, 'unexpected audience'],
      [
        'service account',
        { ...good, email: 'other@x.iam.gserviceaccount.com' },
        'unexpected service account',
      ],
      ['unverified email', { ...good, email_verified: false }, 'unexpected service account'],
      ['expiry', { ...good, exp: now / 1_000 - 120 }, 'token expired'],
    ])('rejects a wrong %s', async (_n, claims, reason) => {
      expect(await new GoogleOidcVerifier(config).verify(sign(claims), now)).toEqual({
        ok: false,
        reason,
      });
    });

    it('rejects bad signatures, other algorithms, unknown keys and missing tokens', async () => {
      const verifier = new GoogleOidcVerifier(config);
      const token = sign(good);
      const tampered = token.replace(
        /\.[^.]+\./,
        `.${b64url(JSON.stringify({ ...good, aud: 'x' }))}.`,
      );
      expect(await verifier.verify(tampered, now)).toMatchObject({ ok: false });
      expect(await verifier.verify(sign(good, { alg: 'HS256', kid: 'k1' }), now)).toEqual({
        ok: false,
        reason: 'unexpected token algorithm',
      });
      expect(await verifier.verify(sign(good, { alg: 'RS256', kid: 'nope' }), now)).toEqual({
        ok: false,
        reason: 'unknown signing key',
      });
      expect(await verifier.verify(undefined, now)).toEqual({
        ok: false,
        reason: 'bearer token missing',
      });
    });
  });

  describe('push adapter', () => {
    const provider = new GmailPushProvider(
      { gmail: {} } as never,
      {} as never,
      {} as never,
      {} as never,
      { setContext: () => undefined } as never,
    );
    const push = (data: object, messageId = '123456') => ({
      headers: {},
      rawBody: Buffer.alloc(0),
      body: {
        message: { data: Buffer.from(JSON.stringify(data)).toString('base64'), messageId },
        subscription: 'projects/p/subscriptions/s',
      },
    });

    it('stores only the mailbox and history id, deferred to the worker', () => {
      expect(
        provider.normalize(push({ emailAddress: 'Support@Example.com', historyId: 9876 })),
      ).toEqual({
        eventType: 'gmail.mailbox.changed',
        resourceKey: 'support@example.com',
        data: { emailAddress: 'support@example.com', historyId: '9876' },
        deferred: true,
      });
      expect(provider.deliveryId(push({}))).toBe('pubsub:123456');
      expect(provider.normalize(push({ emailAddress: 'a@b.co', historyId: 'x' }))).toBeNull();
      expect(provider.normalize({ headers: {}, rawBody: Buffer.alloc(0), body: {} })).toBeNull();
    });
  });

  describe('triggers', () => {
    it('filters self-sent mail, sender and subject', () => {
      const email = {
        labelIds: ['INBOX'],
        from: 'Ada <ada@example.org>',
        subject: 'URGENT: login broken',
      };
      expect(passes({}, email, 'support@example.com')).toBe(true);
      expect(passes({}, { ...email, labelIds: ['INBOX', 'SENT'] }, 'support@example.com')).toBe(
        false,
      );
      expect(passes({}, { ...email, from: 'support@example.com' }, 'support@example.com')).toBe(
        false,
      );
      expect(
        passes({ includeSentByMe: true }, { ...email, labelIds: ['SENT'] }, 'support@example.com'),
      ).toBe(true);
      expect(passes({ from: 'example.org' }, email, 'support@example.com')).toBe(true);
      expect(passes({ from: 'acme.com' }, email, 'support@example.com')).toBe(false);
      expect(passes({ subjectContains: 'urgent' }, email, 'support@example.com')).toBe(true);
      expect(passes({ subjectContains: 'invoice' }, email, 'support@example.com')).toBe(false);
    });

    it('validates configs, routes by connection, and is unavailable without Pub/Sub', () => {
      const types = gmailNodeTypes(true);
      const label = types.find((t) => t.type === 'gmail.email.labelReceived')!;
      const config = {
        connectionId: '6f2b8c1e-1d1a-4c3b-9a7e-2b1c3d4e5f60',
        labelId: 'Label_12',
        filter: { subjectContains: 'support' },
      };
      expect(label.configSchema.safeParse(config).success).toBe(true);
      expect(label.route!(label.configSchema.parse(config) as Record<string, unknown>)).toEqual({
        provider: 'GMAIL',
        eventType: 'gmail.email.labelReceived',
        resourceKey: config.connectionId,
        connectionId: config.connectionId,
        filter: { labelId: 'Label_12', includeSentByMe: false, subjectContains: 'support' },
      });
      expect(
        label.configSchema.safeParse({ ...config, filter: { query: 'is:unread' } }).success,
      ).toBe(false); // not implemented → refused
      expect(
        gmailNodeTypes(false).find((t) => t.type === 'gmail.email.received')!.unavailableReason,
      ).toMatch(/PUBSUB/);
      expect(
        gmailNodeTypes(false).find((t) => t.type === 'gmail.sendEmail')!.unavailableReason,
      ).toBeUndefined();
    });
  });
});
