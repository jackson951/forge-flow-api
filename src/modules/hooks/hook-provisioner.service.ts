import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EncryptionService } from '../../infrastructure/crypto/encryption.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { WebhookTriggerConfig } from './hook-config';

export const hashHookId = (hookId: string) => createHash('sha256').update(hookId).digest('hex');
/** 128-bit random, URL-safe: the capability in the webhook URL. */
export const newHookId = () => randomBytes(16).toString('base64url');
/** 256-bit random verification secret. */
export const newHookSecret = () => randomBytes(32).toString('base64url');
export const secretHint = (secret: string) => (secret.length >= 12 ? `…${secret.slice(-4)}` : '…');

type Field = 'hookId' | 'secret' | 'previousSecret';
const aad = (webhookId: string, field: Field) =>
  `workflow-webhook:${webhookId}:${field === 'previousSecret' ? 'secret' : field}`;

/**
 * Creates and updates a workflow's generic webhook (Part 24). Called by the trigger routing in
 * the publish / archive / unarchive transactions, and by the admin API. Only this module and
 * the intake seal or open hook secrets; responses never include them except where an admin is
 * shown a new secret once.
 */
@Injectable()
export class HookProvisioner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  seal(webhookId: string, field: Field, value: string): string {
    return this.encryption.encrypt(value, aad(webhookId, field));
  }

  open(webhookId: string, field: Field, value: string): string {
    return this.encryption.decrypt(value, aad(webhookId, field));
  }

  /** The row, created (inactive, with a new URL and secret) if the workflow has none yet. */
  async ensure(
    workflow: { id: string; workspaceId: string },
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const existing = await tx.workflowWebhook.findUnique({ where: { workflowId: workflow.id } });
    if (existing) return existing;
    const id = randomUUID();
    const hookId = newHookId();
    const secret = newHookSecret();
    // The row id is part of the AAD, so it is chosen before the insert.
    return tx.workflowWebhook.create({
      data: {
        id,
        workspaceId: workflow.workspaceId,
        workflowId: workflow.id,
        hookIdHash: hashHookId(hookId),
        encryptedHookId: this.seal(id, 'hookId', hookId),
        encryptedSecret: this.seal(id, 'secret', secret),
        secretHint: secretHint(secret),
      },
    });
  }

  /** The active version's trigger is webhook.received: store its config and accept deliveries. */
  async activate(
    tx: Prisma.TransactionClient,
    workflow: { id: string; workspaceId: string },
    versionId: string,
    config: WebhookTriggerConfig,
  ): Promise<void> {
    const row = await this.ensure(workflow, tx);
    await tx.workflowWebhook.update({
      where: { id: row.id },
      data: {
        workflowVersionId: versionId,
        config: config as unknown as Prisma.InputJsonObject,
        active: true,
      },
    });
  }

  /** Archive, or a version with another trigger: the URL is kept but answers 404. */
  async deactivate(tx: Prisma.TransactionClient, workflowId: string): Promise<void> {
    await tx.workflowWebhook.updateMany({ where: { workflowId }, data: { active: false } });
  }
}
