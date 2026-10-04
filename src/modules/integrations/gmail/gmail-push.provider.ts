import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { IntegrationProviderKey } from '@prisma/client';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../../config/app-config.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { GmailSyncJobData, JOBS, QUEUES } from '../../../infrastructure/queue/queue.constants';
import {
  header,
  InboundWebhook,
  NormalizedEvent,
  VerificationResult,
  WebhookProvider,
} from '../../webhooks/providers/webhook-provider';
import { GoogleOidcVerifier } from './google-oidc-verifier';

interface PubSubPush {
  message?: { data?: string; messageId?: string; message_id?: string };
  subscription?: string;
}

/** Notifications of one mailbox within this window coalesce into one history resolution. */
const COALESCE_MS = 2_000;

/**
 * Gmail push notifications via Pub/Sub (Part 26, FR-26.5): `POST /webhooks/gmail`.
 * Verifies the push OIDC token, dedups by the Pub/Sub message id, stores only
 * `{ emailAddress, historyId }`, and hands off to a worker job per connection watching that
 * mailbox. No Gmail API call happens in the request; runs are created by the history resolution.
 */
@Injectable()
export class GmailPushProvider implements WebhookProvider {
  readonly slug = 'gmail';
  readonly key = IntegrationProviderKey.GMAIL;

  constructor(
    private readonly config: AppConfigService,
    private readonly oidc: GoogleOidcVerifier,
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.PROVIDER_EVENTS) private readonly events: Queue<GmailSyncJobData>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GmailPushProvider.name);
  }

  isEnabled(): boolean {
    const { pushAudience, pushServiceAccount } = this.config.gmail;
    return Boolean(pushAudience && pushServiceAccount);
  }

  verify(request: InboundWebhook): Promise<VerificationResult> {
    return this.oidc.verify(header(request, 'authorization'));
  }

  deliveryId(request: InboundWebhook): string | undefined {
    const message = (request.body as PubSubPush | undefined)?.message;
    const id = message?.messageId ?? message?.message_id;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? `pubsub:${id}` : undefined;
  }

  eventName(): string {
    return 'gmail.notification';
  }

  normalize(request: InboundWebhook): NormalizedEvent | null {
    const data = (request.body as PubSubPush | undefined)?.message?.data;
    if (typeof data !== 'string') return null;
    let decoded: { emailAddress?: unknown; historyId?: unknown };
    try {
      decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as typeof decoded;
    } catch {
      return null;
    }
    const email =
      typeof decoded.emailAddress === 'string' ? decoded.emailAddress.toLowerCase() : '';
    const historyId =
      typeof decoded.historyId === 'number' || typeof decoded.historyId === 'string'
        ? String(decoded.historyId)
        : '';
    if (!email || !/^\d{1,20}$/.test(historyId)) return null;
    return {
      eventType: 'gmail.mailbox.changed',
      resourceKey: email,
      data: { emailAddress: email, historyId },
      deferred: true,
    };
  }

  /** After the delivery is stored: one coalesced resolution job per connection on this mailbox. */
  async afterRecord(event: NormalizedEvent): Promise<void> {
    const connections = await this.prisma.providerSubscription.findMany({
      where: {
        provider: IntegrationProviderKey.GMAIL,
        connection: { accountLabel: event.resourceKey },
      },
      select: { connectionId: true },
    });
    const bucket = Math.floor(Date.now() / COALESCE_MS);
    for (const { connectionId } of connections) {
      await this.events
        .add(
          JOBS.GMAIL_SYNC,
          { connectionId },
          {
            jobId: `gmail-sync-${connectionId}-${bucket}`,
            removeOnComplete: true,
            removeOnFail: 100,
          },
        )
        .catch((err: Error) =>
          this.logger.warn(
            { connectionId, error: err.message },
            'Could not queue the Gmail resolution; renewal will catch up',
          ),
        );
    }
  }
}
