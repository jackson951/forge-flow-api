import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, ScheduleKind } from '@prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { PinoLogger } from 'nestjs-pino';
import { WebhookTriggerConfig } from '../hooks/hook-config';
import { HookProvisioner } from '../hooks/hook-provisioner.service';
import { NodeTypeCatalog } from '../../engine/catalog/node-type-catalog';
import { deriveTriggerRoutes } from '../../engine/catalog/trigger-routes';
import { parseDefinition, WorkflowDefinition } from '../../engine/definition/definition.schema';
import {
  compileSchedule,
  describeSchedule,
  nextOccurrence,
  ScheduleSpec,
} from '../../engine/schedule/schedule';

/**
 * Keeps a workflow's trigger tables in step with its active version: WorkflowTrigger rows for
 * webhook triggers and the WorkflowSchedule row for a schedule trigger (Part 23).
 * Always called inside the transaction that changes the active version or the status.
 */
@Injectable()
export class TriggerRoutingService {
  constructor(
    private readonly catalog: NodeTypeCatalog,
    private readonly logger: PinoLogger,
    private readonly hooks: HookProvisioner,
    private readonly config: AppConfigService,
  ) {
    this.logger.setContext(TriggerRoutingService.name);
  }

  async activate(
    tx: Prisma.TransactionClient,
    workflow: { id: string; workspaceId: string },
    version: { id: string; definition: unknown },
  ): Promise<void> {
    const parsed = parseDefinition(version.definition);
    if (!parsed.ok) throw new Error(`Stored version ${version.id} does not match the schema`);

    await tx.workflowTrigger.deleteMany({ where: { workflowId: workflow.id } });
    const routes = deriveTriggerRoutes(parsed.definition, this.catalog);
    if (routes.length) {
      await tx.workflowTrigger.createMany({
        data: routes.map((route) => ({
          ...route,
          filter: route.filter as Prisma.InputJsonObject | undefined,
          workspaceId: workflow.workspaceId,
          workflowId: workflow.id,
          workflowVersionId: version.id,
        })),
      });
    }
    await this.activateSchedule(tx, workflow, version.id, parsed.definition);
    await this.activateWebhook(tx, workflow, version.id, parsed.definition);
  }

  /** Archive: no webhook routes, and the schedule stops (kept for its history, inactive). */
  async deactivate(tx: Prisma.TransactionClient, workflowId: string): Promise<void> {
    await tx.workflowTrigger.deleteMany({ where: { workflowId } });
    await tx.workflowSchedule.updateMany({
      where: { workflowId },
      data: { active: false, nextRunAt: null },
    });
    await this.hooks.deactivate(tx, workflowId);
  }

  /** Generic webhook trigger (Part 24): keeps the URL across versions; inactive otherwise. */
  private async activateWebhook(
    tx: Prisma.TransactionClient,
    workflow: { id: string; workspaceId: string },
    versionId: string,
    definition: WorkflowDefinition,
  ): Promise<void> {
    const trigger = definition.nodes.find((n) => n.kind === 'TRIGGER');
    const type = trigger && this.catalog.get(trigger.type);
    const parsed =
      trigger && type?.webhook ? type.configSchema.safeParse(trigger.config) : undefined;
    if (!parsed?.success) {
      await this.hooks.deactivate(tx, workflow.id);
      return;
    }
    await this.hooks.activate(tx, workflow, versionId, parsed.data as WebhookTriggerConfig);
  }

  /**
   * Upserts the schedule with `nextRunAt` computed from now — a new version or an unarchive
   * never backfills occurrences (FR-23.4/23.5). A version without a schedule trigger removes it.
   */
  private async activateSchedule(
    tx: Prisma.TransactionClient,
    workflow: { id: string; workspaceId: string },
    versionId: string,
    definition: WorkflowDefinition,
  ): Promise<void> {
    const trigger = definition.nodes.find((n) => n.kind === 'TRIGGER');
    const type = trigger && this.catalog.get(trigger.type);
    if (!trigger || !type?.schedule) {
      await tx.workflowSchedule.deleteMany({ where: { workflowId: workflow.id } });
      return;
    }

    // Re-checked on every activation: a version published under other rules (an operator
    // raised the minimum interval, a timezone left the runtime) is kept but inactive.
    const valid = type.configSchema.safeParse(trigger.config);
    const spec = type.schedule(trigger.config) as ScheduleSpec;
    const compiled = valid.success ? compileSchedule(spec) : null;
    const nextRunAt = compiled ? nextOccurrence(compiled, new Date()) : null;
    if (!nextRunAt) {
      this.logger.warn(
        { workflowId: workflow.id, workflowVersionId: versionId, nodeKey: trigger.key },
        'Schedule deactivated: its configuration is no longer valid on this server',
      );
    }
    const kind = type.scheduleKind === 'POLL' ? ScheduleKind.POLL : ScheduleKind.RUN;
    if (kind === ScheduleKind.POLL) await this.assertPollQuota(tx, workflow);
    const data = {
      workflowVersionId: versionId,
      kind,
      cron: compiled?.cron ?? '',
      timezone: typeof spec?.timezone === 'string' ? spec.timezone : '',
      config: trigger.config as Prisma.InputJsonObject,
      description: compiled ? describeSchedule(spec) : 'Invalid schedule',
      active: Boolean(nextRunAt),
      nextRunAt,
    };
    await tx.workflowSchedule.upsert({
      where: { workflowId: workflow.id },
      create: { ...data, workspaceId: workflow.workspaceId, workflowId: workflow.id },
      update: data,
    });
  }

  /** Per-workspace limit on active http.poll triggers, so polling cannot be used for abuse. */
  private async assertPollQuota(
    tx: Prisma.TransactionClient,
    workflow: { id: string; workspaceId: string },
  ): Promise<void> {
    const max = this.config.http.maxPollsPerWorkspace;
    const active = await tx.workflowSchedule.count({
      where: {
        workspaceId: workflow.workspaceId,
        kind: ScheduleKind.POLL,
        active: true,
        workflowId: { not: workflow.id },
      },
    });
    if (active >= max) {
      throw new UnprocessableEntityException({
        message: `This workspace already has ${max} active HTTP poll triggers (the limit)`,
        details: { code: 'POLL_QUOTA_EXCEEDED', limit: max },
      });
    }
  }
}
