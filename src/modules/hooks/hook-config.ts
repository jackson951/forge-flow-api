import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { conditionConfigSchema } from '../../engine/expressions/conditions';
import { HEADER_NAME } from '../integrations/http/http-auth';

/**
 * Generic inbound webhook (Part 24, FR-24.7–24.13). Pure: config schema, verification,
 * payload parsing and the trigger output. No database, Redis or Nest.
 */

export const HOOK_METHODS = ['POST', 'PUT', 'PATCH', 'GET'] as const;
export type HookMethod = (typeof HOOK_METHODS)[number];

const headerName = z.string().regex(HEADER_NAME, 'must be a valid HTTP header name');

/** Header names never copied into the trigger output (credentials and signatures). */
const NEVER_STORED = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-flowforge-token',
  'x-flowforge-signature',
  'x-hub-signature',
  'x-hub-signature-256',
  'x-slack-signature',
  'stripe-signature',
]);

/** Headers kept in the trigger output by default (plus `includeHeaders`). */
const DEFAULT_HEADERS = [
  'content-type',
  'user-agent',
  'x-request-id',
  'idempotency-key',
  'x-github-event',
  'x-github-delivery',
  'x-event-type',
  'x-event-id',
];

const cidr = z.string().refine(isValidCidr, 'use an IP address or CIDR range, e.g. 203.0.113.0/24');

export const verificationSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('none'),
      /** Anyone with the URL can start the workflow: must be acknowledged explicitly. */
      acknowledgeUnverified: z.literal(true, {
        errorMap: () => ({
          message:
            'Unverified webhooks accept requests from anyone with the URL; set acknowledgeUnverified: true',
        }),
      }),
    })
    .strict(),
  z
    .object({
      mode: z.literal('token'),
      /** `header`: the secret in `headerName`; `bearer`: `Authorization: Bearer <secret>`. */
      location: z.enum(['header', 'bearer']).default('header'),
      headerName: headerName.default('X-FlowForge-Token'),
    })
    .strict(),
  z
    .object({
      mode: z.literal('basic'),
      username: z
        .string()
        .min(1)
        .max(100)
        .refine((v) => !v.includes(':'), 'must not contain ":"'),
    })
    .strict(),
  z
    .object({
      mode: z.literal('hmac'),
      algorithm: z.enum(['sha256', 'sha1', 'sha512']).default('sha256'),
      headerName: headerName.default('X-FlowForge-Signature'),
      encoding: z.enum(['hex', 'base64']).default('hex'),
      /** e.g. "sha256=" (GitHub). */
      prefix: z.string().max(20).default(''),
      /** Timestamped signatures with a replay window (Slack/Stripe style). */
      timestamp: z
        .object({
          headerName,
          toleranceSeconds: z.number().int().min(30).max(3_600).default(300),
          /** What is signed: "<timestamp>.<body>" or "v0:<timestamp>:<body>". */
          format: z
            .enum(['{timestamp}.{body}', 'v0:{timestamp}:{body}'])
            .default('{timestamp}.{body}'),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
export type HookVerification = z.infer<typeof verificationSchema>;

const deduplicationSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('none') }).strict(),
  z.object({ source: z.literal('header'), header: headerName }).strict(),
  z
    .object({
      source: z.literal('body'),
      /** Dot path into a JSON body, e.g. "event.id". */
      path: z
        .string()
        .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){0,9}$/, 'use a dot path such as event.id'),
    })
    .strict(),
]);

const responseSchema = z
  .object({
    status: z.union([z.literal(200), z.literal(202), z.literal(204)]).default(202),
    /** Small static JSON reply for senders that expect one (replaces the default body). */
    body: z
      .record(z.unknown())
      .refine((b) => Buffer.byteLength(JSON.stringify(b)) <= 1_024, 'at most 1 KB')
      .optional(),
  })
  .strict();

export const webhookTriggerConfigSchema = z
  .object({
    methods: z
      .array(z.enum(HOOK_METHODS))
      .min(1)
      .max(4)
      .refine((m) => new Set(m).size === m.length, 'methods must not repeat')
      .default(['POST']),
    verification: verificationSchema.default({
      mode: 'token',
      location: 'header',
      headerName: 'X-FlowForge-Token',
    }),
    ipAllowList: z.array(cidr).max(50).default([]),
    deduplication: deduplicationSchema.default({ source: 'none' }),
    /** Deliveries that do not match are stored as IGNORED and start no run (FR-24.12). */
    filter: conditionConfigSchema.optional(),
    response: responseSchema.default({ status: 202 }),
    /** GET endpoint validation: `?<queryParam>=x` is answered with `x` (FR-24.13). */
    challenge: z
      .object({ queryParam: z.string().regex(/^[A-Za-z0-9_.-]{1,50}$/) })
      .strict()
      .optional(),
    includeHeaders: z.array(headerName).max(20).default([]),
    rateLimitPerMinute: z.number().int().min(1).max(600).default(120),
  })
  .strict();
export type WebhookTriggerConfig = z.infer<typeof webhookTriggerConfigSchema>;

// ── Verification ─────────────────────────────────────────────────────────────

export interface InboundHookRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  rawBody: Buffer;
  sourceIp: string;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

const header = (req: InboundHookRequest, name: string): string | undefined => {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

/** Constant time, whatever the lengths (both sides hashed to 32 bytes first). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/**
 * Checks a request against the verification mode with any of `secrets` (current, and the
 * previous one during a rotation grace period). Reasons are for logs only, never responses.
 */
export function verifyHookRequest(
  config: WebhookTriggerConfig,
  req: InboundHookRequest,
  secrets: string[],
  now = Date.now(),
): VerifyResult {
  if (config.ipAllowList.length && !ipAllowed(req.sourceIp, config.ipAllowList)) {
    return { ok: false, reason: 'source IP not in the allow-list' };
  }
  const v = config.verification;
  if (v.mode === 'none') return { ok: true };
  if (!secrets.length) return { ok: false, reason: 'no secret configured' };

  switch (v.mode) {
    case 'token': {
      const raw =
        v.location === 'bearer'
          ? /^Bearer\s+(.+)$/i.exec(header(req, 'authorization') ?? '')?.[1]
          : header(req, v.headerName);
      if (!raw) return { ok: false, reason: 'token missing' };
      return secrets.some((s) => safeEqual(raw.trim(), s))
        ? { ok: true }
        : { ok: false, reason: 'token mismatch' };
    }
    case 'basic': {
      const encoded = /^Basic\s+(.+)$/i.exec(header(req, 'authorization') ?? '')?.[1];
      if (!encoded) return { ok: false, reason: 'basic credentials missing' };
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator < 0) return { ok: false, reason: 'malformed basic credentials' };
      const userOk = safeEqual(decoded.slice(0, separator), v.username);
      const passOk = secrets.some((s) => safeEqual(decoded.slice(separator + 1), s));
      return userOk && passOk ? { ok: true } : { ok: false, reason: 'basic credentials mismatch' };
    }
    case 'hmac': {
      const provided = header(req, v.headerName);
      if (!provided) return { ok: false, reason: 'signature missing' };
      let signed: Buffer = req.rawBody;
      if (v.timestamp) {
        const ts = header(req, v.timestamp.headerName);
        if (!ts || !/^\d{1,13}$/.test(ts)) return { ok: false, reason: 'timestamp missing' };
        const ms = ts.length > 10 ? Number(ts) : Number(ts) * 1_000;
        if (Math.abs(now - ms) > v.timestamp.toleranceSeconds * 1_000) {
          return { ok: false, reason: 'timestamp outside the replay window' };
        }
        const [before, after] =
          v.timestamp.format === 'v0:{timestamp}:{body}' ? ['v0:', ':'] : ['', '.'];
        signed = Buffer.concat([Buffer.from(`${before}${ts}${after}`), req.rawBody]);
      }
      const value = provided.trim();
      return secrets.some((s) => {
        const expected = v.prefix + createHmac(v.algorithm, s).update(signed).digest(v.encoding);
        return safeEqual(value, expected);
      })
        ? { ok: true }
        : { ok: false, reason: 'signature mismatch' };
    }
  }
}

export function isValidCidr(value: string): boolean {
  const [address, prefix, extra] = value.split('/');
  if (extra !== undefined) return false;
  const family = isIP(address);
  if (!family) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

export function ipAllowed(ip: string, ranges: string[]): boolean {
  const list = new BlockList();
  for (const range of ranges) {
    const [address, prefix] = range.split('/');
    const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  const candidate = mapped ?? ip;
  const family = isIP(candidate);
  if (!family) return false;
  return list.check(candidate, family === 4 ? 'ipv4' : 'ipv6');
}

// ── Payload ──────────────────────────────────────────────────────────────────

export class MalformedPayloadError extends Error {}

export interface ParsedBody {
  body: unknown;
  rawText?: string;
  contentType: string;
}

/** JSON, form, text; anything else is kept as text (size already capped by the parser). */
export function parseHookBody(rawBody: Buffer, contentTypeHeader: string | undefined): ParsedBody {
  const contentType = (contentTypeHeader ?? '').split(';')[0].trim().toLowerCase();
  if (rawBody.length === 0) return { body: null, contentType };
  const text = rawBody.toString('utf8');
  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    try {
      return { body: JSON.parse(text) as unknown, contentType };
    } catch {
      throw new MalformedPayloadError('Malformed JSON body');
    }
  }
  if (contentType === 'application/x-www-form-urlencoded') {
    const out: Record<string, string | string[]> = {};
    for (const [key, value] of new URLSearchParams(text)) {
      const existing = out[key];
      out[key] = existing === undefined ? value : ([] as string[]).concat(existing, value);
    }
    return { body: out, contentType };
  }
  if (contentType.startsWith('text/') && !contentType.includes('xml')) {
    return { body: text, contentType };
  }
  // XML and anything else: raw text for the workflow to use.
  return { body: null, rawText: text, contentType };
}

export interface HookTriggerOutput {
  method: string;
  headers: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  rawText?: string;
  contentType: string;
  receivedAt: string;
  deliveryId: string;
  sourceIp: string;
}

/** Headers kept in the trigger output: defaults + configured, never credentials/signatures. */
export function pickHeaders(
  headers: InboundHookRequest['headers'],
  config: WebhookTriggerConfig,
): Record<string, string> {
  const excluded = new Set(NEVER_STORED);
  const v = config.verification;
  if (v.mode === 'token' && v.location === 'header') excluded.add(v.headerName.toLowerCase());
  if (v.mode === 'hmac') {
    excluded.add(v.headerName.toLowerCase());
  }
  const wanted = new Set([
    ...DEFAULT_HEADERS,
    ...config.includeHeaders.map((h) => h.toLowerCase()),
  ]);
  const out: Record<string, string> = {};
  for (const name of wanted) {
    if (excluded.has(name)) continue;
    const value = headers[name];
    if (value === undefined) continue;
    out[name] = (Array.isArray(value) ? value.join(', ') : value).slice(0, 1_024);
  }
  return out;
}

/** Query string values as received (strings or arrays of strings), capped. */
export function pickQuery(query: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(query)
      .slice(0, 50)
      .map(([k, v]) => [
        k,
        Array.isArray(v) ? v.slice(0, 20).map(String) : String(v).slice(0, 2_048),
      ]),
  );
}

/**
 * The sender's delivery id from the configured source (FR-24.11), or undefined (every
 * request is then distinct).
 */
export function sourceDeliveryId(
  config: WebhookTriggerConfig,
  headers: InboundHookRequest['headers'],
  body: unknown,
): string | undefined {
  const d = config.deduplication;
  let value: unknown;
  if (d.source === 'header') {
    const raw = headers[d.header.toLowerCase()];
    value = Array.isArray(raw) ? raw[0] : raw;
  } else if (d.source === 'body') {
    value = d.path
      .split('.')
      .reduce<unknown>(
        (node, key) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined,
        body,
      );
  }
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 200 ? trimmed : undefined;
}
