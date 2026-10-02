import { ConnectionStatus, IntegrationProviderKey } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** What the pipeline receives for every webhook request. */
export interface InboundWebhook {
  headers: Record<string, string | string[] | undefined>;
  /** Exact bytes as received — signatures are computed over these, never re-serialised JSON. */
  rawBody: Buffer;
  body: unknown;
}

/** Provider-neutral event used for trigger matching and as the run's trigger input. */
export interface NormalizedEvent {
  /** Matches WorkflowTrigger.eventType, e.g. "issues.opened". */
  eventType: string;
  /** Matches WorkflowTrigger.resourceKey, e.g. "<installationId>:owner/repo". */
  resourceKey: string;
  /** Becomes `trigger.*` in the workflow. Only fields workflows need; no secrets. */
  data: Record<string, unknown>;
  /**
   * Provider account that sent the event (e.g. GitHub installation id). When set, only
   * triggers whose CONNECTED connection has this externalAccountId match — a repository name
   * alone is never enough to route an event into a workspace.
   */
  accountId?: string;
  /** Account lifecycle events (e.g. app uninstalled) update matching connections. */
  connectionStatus?: ConnectionStatus;
}

export type VerificationResult = { ok: true } | { ok: false; reason: string };

/**
 * One adapter per provider (docs/backend/09-WEBHOOK-PLATFORM.md). Adapters are pure: no
 * database, no outbound calls — the request must be acknowledged quickly.
 */
export interface WebhookProvider {
  /** URL segment: POST /api/v1/webhooks/<slug>. */
  readonly slug: string;
  readonly key: IntegrationProviderKey;
  isEnabled(): boolean;
  /** Signature (and timestamp/replay window if the provider has one). Constant-time compare. */
  verify(request: InboundWebhook): VerificationResult;
  /** Provider's unique id of this delivery; used for deduplication. */
  deliveryId(request: InboundWebhook): string | undefined;
  /** Raw provider event name, stored on the delivery for diagnostics. */
  eventName(request: InboundWebhook): string;
  /** null = an event type FlowForge does not act on (stored as IGNORED). */
  normalize(request: InboundWebhook): NormalizedEvent | null;
}

export const WEBHOOK_PROVIDERS = Symbol('WEBHOOK_PROVIDERS');

export function header(request: InboundWebhook, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Compares `sha256=<hex>` signatures in constant time (length is checked first). */
export function hmacSha256Matches(
  secret: string,
  payload: Buffer | string,
  signature: string | undefined,
): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`,
  );
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
