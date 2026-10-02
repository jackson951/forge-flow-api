/**
 * Rate limits (Part 18, FR-18.2), in one place. Counters live in Redis
 * (RedisThrottlerStorage), so they hold across API instances.
 *
 * Two throttlers apply to every route:
 * - `default`: 300/min per authenticated user (per IP for public routes); auth and webhook
 *   routes override it with their own, stricter keys and limits;
 * - `ip`: a generous per-IP flood cap, tightened to 20/min on login.
 */
export const MINUTE = 60_000;

export const RATE_LIMITS = {
  authenticatedPerUser: 300,
  perIpFloodCap: 3_000,
  loginPerIpAndEmail: 5,
  loginPerIp: 20,
  registerPerIp: 5,
  refreshPerIp: 30,
  webhookPerProviderAndIp: 600,
} as const;

type TrackedRequest = Record<string, unknown> & {
  ip?: string;
  user?: { userId?: string };
  body?: unknown;
  params?: Record<string, string>;
};

const ipOf = (req: TrackedRequest) => req.ip ?? 'unknown';

/** Client IP (correct behind a load balancer when TRUST_PROXY is set). */
export const byIp = (req: Record<string, unknown>): string => `ip:${ipOf(req as TrackedRequest)}`;

/** Authenticated user when known (the auth guard runs first), otherwise the IP. */
export const byUserOrIp = (req: Record<string, unknown>): string => {
  const r = req as TrackedRequest;
  return r.user?.userId ? `user:${r.user.userId}` : `ip:${ipOf(r)}`;
};

/** Login: IP + submitted email, so one attacked account does not lock out a shared IP. */
export const byIpAndEmail = (req: Record<string, unknown>): string => {
  const r = req as TrackedRequest;
  const email = (r.body as { email?: unknown } | undefined)?.email;
  const normalized = typeof email === 'string' ? email.trim().toLowerCase().slice(0, 320) : '';
  return `ip:${ipOf(r)}:email:${normalized}`;
};

/** Webhooks: per provider and sender IP. */
export const byProviderAndIp = (req: Record<string, unknown>): string => {
  const r = req as TrackedRequest;
  const provider = String(r.params?.provider ?? 'unknown').slice(0, 32);
  return `provider:${provider}:ip:${ipOf(r)}`;
};
