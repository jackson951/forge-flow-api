import { Injectable } from '@nestjs/common';
import { createPublicKey, JsonWebKey, KeyObject, verify } from 'node:crypto';
import { AppConfigService } from '../../../config/app-config.service';

const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const LEEWAY_S = 60;
const KEYS_TTL_MS = 60 * 60_000;
/** An unknown key id triggers at most one key download per minute. */
const REFRESH_COOLDOWN_MS = 60_000;

export type OidcResult = { ok: true } | { ok: false; reason: string };

/**
 * Verifies the OIDC token Pub/Sub push subscriptions send (Part 26, FR-26.5), offline against
 * Google's public keys: RS256 signature, issuer accounts.google.com, audience = the configured
 * push audience, email = the configured push service account with email_verified, not expired.
 * Source: docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions.
 */
@Injectable()
export class GoogleOidcVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private lastRefresh = 0;

  constructor(private readonly config: AppConfigService) {}

  async verify(authorization: string | undefined, now = Date.now()): Promise<OidcResult> {
    const { pushAudience, pushServiceAccount } = this.config.gmail;
    if (!pushAudience || !pushServiceAccount)
      return { ok: false, reason: 'push verification not configured' };
    const token = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1]?.trim();
    if (!token) return { ok: false, reason: 'bearer token missing' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed token' };

    let header: { alg?: unknown; kid?: unknown };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as {
        alg?: unknown;
        kid?: unknown;
      };
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      return { ok: false, reason: 'malformed token' };
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string')
      return { ok: false, reason: 'unexpected token algorithm' };

    const key = await this.key(header.kid, now);
    if (!key) return { ok: false, reason: 'unknown signing key' };
    const valid = verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      Buffer.from(parts[2], 'base64url'),
    );
    if (!valid) return { ok: false, reason: 'token signature mismatch' };

    const seconds = now / 1_000;
    if (!ISSUERS.has(String(claims.iss))) return { ok: false, reason: 'unexpected issuer' };
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(pushAudience)) return { ok: false, reason: 'unexpected audience' };
    if (claims.email !== pushServiceAccount || claims.email_verified !== true) {
      return { ok: false, reason: 'unexpected service account' };
    }
    if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S < seconds)
      return { ok: false, reason: 'token expired' };
    if (typeof claims.iat === 'number' && claims.iat - LEEWAY_S > seconds)
      return { ok: false, reason: 'token not yet valid' };
    return { ok: true };
  }

  private async key(kid: string, now: number): Promise<KeyObject | undefined> {
    const stale = now - this.fetchedAt > KEYS_TTL_MS;
    if (stale || (!this.keys.has(kid) && now - this.lastRefresh > REFRESH_COOLDOWN_MS)) {
      await this.refresh(now).catch(() => undefined);
    }
    return this.keys.get(kid);
  }

  private async refresh(now: number): Promise<void> {
    this.lastRefresh = now;
    const res = await fetch(this.config.gmail.jwksUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Google keys unavailable (${res.status})`);
    const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    const keys = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid || jwk.kty !== 'RSA') continue;
      try {
        keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      } catch {
        // skip malformed keys
      }
    }
    if (keys.size) {
      this.keys = keys;
      this.fetchedAt = now;
    }
  }
}
