import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Authenticity of Jira webhook deliveries (Part 25, FR-25.5). Two independent checks:
 *
 * 1. Atlassian's documented mechanism for OAuth 2.0 apps: "Webhooks for OAuth 2.0 apps are
 *    secured by bearer authentication. The token is present in the Authorization header and is
 *    signed with the app's client secret" (developer.atlassian.com/cloud/jira/platform/webhooks).
 *    The page names no algorithm; HMAC-SHA256 (JWT HS256) is used, as in Atlassian's other
 *    shared-secret JWTs. To confirm with the real-site E2E.
 * 2. Our own: the registered URL carries the connection and site, signed with the same secret
 *    (`sig`), so a delivery routes only to the connection whose webhook received it.
 */

const b64url = (buf: Buffer) => buf.toString('base64url');
const sign = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest();

function equal(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Query parameters of the webhook URL registered for (connection, site). */
export function webhookUrlParams(secret: string, connectionId: string, cloudId: string) {
  const sig = b64url(sign(secret, `jira-webhook:${connectionId}:${cloudId}`));
  return { c: connectionId, s: cloudId, sig };
}

export function webhookUrl(
  base: string,
  secret: string,
  connectionId: string,
  cloudId: string,
): string {
  const url = new URL(`${base.replace(/\/+$/, '')}/webhooks/jira`);
  for (const [k, v] of Object.entries(webhookUrlParams(secret, connectionId, cloudId))) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

/** The connection and site a delivery is for, if the URL signature is valid. */
export function verifyWebhookParams(
  secret: string,
  query: Record<string, unknown>,
): { connectionId: string; cloudId: string } | null {
  const { c, s, sig } = query;
  if (typeof c !== 'string' || typeof s !== 'string' || typeof sig !== 'string') return null;
  if (!/^[0-9a-f-]{36}$/i.test(c) || !/^[A-Za-z0-9-]{1,64}$/.test(s)) return null;
  const expected = sign(secret, `jira-webhook:${c}:${s}`);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  return equal(given, expected) ? { connectionId: c, cloudId: s } : null;
}

/**
 * Verifies `Authorization: Bearer <JWT>` signed HS256 with the app's client secret; rejects
 * other algorithms (including "none") and expired tokens (60 s leeway).
 */
export function verifyBearerJwt(
  secret: string,
  authorization: string | undefined,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  const token = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1]?.trim();
  if (!token) return { ok: false, reason: 'bearer token missing' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  let header: { alg?: unknown };
  let payload: { exp?: unknown; nbf?: unknown };
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: unknown };
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown };
  } catch {
    return { ok: false, reason: 'malformed token' };
  }
  if (header.alg !== 'HS256') return { ok: false, reason: 'unexpected token algorithm' };
  const expected = sign(secret, `${parts[0]}.${parts[1]}`);
  if (!equal(Buffer.from(parts[2], 'base64url'), expected)) {
    return { ok: false, reason: 'token signature mismatch' };
  }
  const leeway = 60;
  const seconds = now / 1_000;
  if (typeof payload.exp === 'number' && payload.exp + leeway < seconds) {
    return { ok: false, reason: 'token expired' };
  }
  if (typeof payload.nbf === 'number' && payload.nbf - leeway > seconds) {
    return { ok: false, reason: 'token not yet valid' };
  }
  return { ok: true };
}

/** For tests and the fake provider: an HS256 JWT. */
export function signJwt(secret: string, payload: Record<string, unknown>): string {
  const head = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${head}.${body}.${b64url(sign(secret, `${head}.${body}`))}`;
}
