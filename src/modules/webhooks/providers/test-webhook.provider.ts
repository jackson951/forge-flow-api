import { Injectable } from '@nestjs/common';
import { IntegrationProviderKey } from '@prisma/client';
import { AppConfigService } from '../../../config/app-config.service';
import {
  header,
  hmacSha256Matches,
  InboundWebhook,
  NormalizedEvent,
  VerificationResult,
  WebhookProvider,
} from './webhook-provider';

export const TEST_REPLAY_WINDOW_MS = 5 * 60_000;

/**
 * Non-production provider for exercising the whole webhook pipeline without GitHub.
 *
 *   X-FlowForge-Delivery:  unique delivery id
 *   X-FlowForge-Event:     event type (matched against WorkflowTrigger.eventType)
 *   X-FlowForge-Timestamp: unix seconds; older/newer than 5 minutes is rejected (replay window)
 *   X-FlowForge-Signature: sha256=HMAC_SHA256(WEBHOOK_TEST_SECRET, "<timestamp>.<raw body>")
 *   body: { "resource": "<resourceKey>", "data": { ... } }
 */
@Injectable()
export class TestWebhookProvider implements WebhookProvider {
  readonly slug = 'test';
  readonly key = IntegrationProviderKey.TEST;

  constructor(private readonly config: AppConfigService) {}

  isEnabled(): boolean {
    return !this.config.isProduction && Boolean(this.config.get('WEBHOOK_TEST_SECRET'));
  }

  verify(request: InboundWebhook): VerificationResult {
    const timestamp = Number(header(request, 'x-flowforge-timestamp'));
    if (!Number.isFinite(timestamp)) return { ok: false, reason: 'missing timestamp' };
    if (Math.abs(Date.now() - timestamp * 1000) > TEST_REPLAY_WINDOW_MS) {
      return { ok: false, reason: 'timestamp outside replay window' };
    }
    const payload = Buffer.concat([Buffer.from(`${timestamp}.`), request.rawBody]);
    const valid = hmacSha256Matches(
      this.config.get('WEBHOOK_TEST_SECRET')!,
      payload,
      header(request, 'x-flowforge-signature'),
    );
    return valid ? { ok: true } : { ok: false, reason: 'signature mismatch' };
  }

  deliveryId(request: InboundWebhook): string | undefined {
    return header(request, 'x-flowforge-delivery');
  }

  eventName(request: InboundWebhook): string {
    return header(request, 'x-flowforge-event') ?? 'unknown';
  }

  normalize(request: InboundWebhook): NormalizedEvent | null {
    const body = request.body as { resource?: unknown; data?: unknown } | null;
    const eventType = header(request, 'x-flowforge-event');
    if (!eventType || typeof body?.resource !== 'string') return null;
    const data =
      body.data && typeof body.data === 'object' && !Array.isArray(body.data)
        ? (body.data as Record<string, unknown>)
        : {};
    return { eventType, resourceKey: body.resource, data };
  }
}
