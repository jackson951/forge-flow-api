import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, WorkflowStatus } from '@prisma/client';
import { definitionHash } from '../../engine/definition/canonical-json';
import { DefinitionValidatorService } from '../../engine/executor/definition-validator.service';
import { hasErrors } from '../../engine/validation/graph-validator';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TriggerRoutingService } from './trigger-routing.service';

const VERSION_SUMMARY_SELECT = {
  id: true,
  version: true,
  schemaVersion: true,
  definitionHash: true,
  publishedAt: true,
  publishedBy: { select: { id: true, name: true } },
} satisfies Prisma.WorkflowVersionSelect;

export type VersionSummary = Prisma.WorkflowVersionGetPayload<{
  select: typeof VERSION_SUMMARY_SELECT;
}> & { isActive: boolean };

export type VersionDetail = VersionSummary & { definition: Prisma.JsonValue };

/**
 * Turns the current draft into an immutable, numbered WorkflowVersion and makes it the
 * active version. Versions are never updated or deleted through the application, and a
 * database trigger rejects changes to their snapshot columns (Part 02).
 */
@Injectable()
export class PublishingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: DefinitionValidatorService,
    private readonly routing: TriggerRoutingService,
    private readonly audit: AuditService,
  ) {}

  async publish(
    workspaceId: string,
    userId: string,
    workflowId: string,
    expectedRevision: number,
  ): Promise<VersionSummary> {
    return this.prisma.$transaction(async (tx) => {
      // Row lock: concurrent publishes of one workflow run one after the other, so version
      // numbers stay gapless; the (workflowId, version) unique constraint is the backstop.
      await tx.$queryRaw`
        SELECT id FROM "Workflow"
        WHERE id = ${workflowId}::uuid AND "workspaceId" = ${workspaceId}::uuid
        FOR UPDATE`;
      const workflow = await tx.workflow.findFirst({ where: { id: workflowId, workspaceId } });
      if (!workflow) throw new NotFoundException('Workflow not found');

      if (workflow.status === WorkflowStatus.ARCHIVED) {
        throw new ConflictException('Archived workflows cannot be published; unarchive first');
      }
      if (workflow.draftRevision !== expectedRevision) {
        throw new ConflictException({
          message: 'The draft was changed since you reviewed it',
          details: { currentRevision: workflow.draftRevision },
        });
      }

      const parsed = this.validator.parse(workflow.draftDefinition);
      if (!parsed.ok) throw new Error('Stored workflow draft does not match the definition schema');
      const issues = this.validator.validate(parsed.definition);
      if (hasErrors(issues)) {
        throw new UnprocessableEntityException({
          message: 'The draft has validation errors and cannot be published',
          details: issues,
        });
      }

      // The normalised (defaults applied) definition is what gets frozen.
      const definition = parsed.definition as unknown as Prisma.InputJsonObject;
      const hash = definitionHash(definition);

      if (workflow.activeVersionId) {
        const active = await tx.workflowVersion.findUniqueOrThrow({
          where: { id: workflow.activeVersionId },
          select: { definitionHash: true },
        });
        if (active.definitionHash === hash) {
          throw new ConflictException({
            message: 'Nothing to publish: the draft matches the active version',
            details: { code: 'NO_CHANGES' },
          });
        }
      }

      const latest = await tx.workflowVersion.aggregate({
        where: { workflowId },
        _max: { version: true },
      });
      const created = await tx.workflowVersion.create({
        data: {
          workspaceId,
          workflowId,
          version: (latest._max.version ?? 0) + 1,
          schemaVersion: parsed.definition.schemaVersion,
          definition,
          definitionHash: hash,
          publishedById: userId,
        },
        select: VERSION_SUMMARY_SELECT,
      });

      await tx.workflow.update({
        where: { id: workflowId },
        data: { activeVersionId: created.id, status: WorkflowStatus.PUBLISHED },
      });
      await this.routing.activate(tx, workflow, { id: created.id, definition });
      await this.audit.record(
        {
          action: 'workflow.published',
          workspaceId,
          actorUserId: userId,
          targetType: 'Workflow',
          targetId: workflowId,
          metadata: { version: created.version, versionId: created.id, definitionHash: hash },
        },
        tx,
      );

      return { ...created, isActive: true };
    });
  }

  async listVersions(
    workspaceId: string,
    workflowId: string,
    limit = 20,
    before?: number,
  ): Promise<{ items: VersionSummary[]; nextCursor: string | null }> {
    const workflow = await this.findWorkflow(workspaceId, workflowId);
    const rows = await this.prisma.workflowVersion.findMany({
      where: { workflowId, workspaceId, ...(before && { version: { lt: before } }) },
      select: VERSION_SUMMARY_SELECT,
      orderBy: { version: 'desc' },
      take: limit + 1,
    });
    const items = rows
      .slice(0, limit)
      .map((v) => ({ ...v, isActive: v.id === workflow.activeVersionId }));
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit && last ? String(last.version) : null };
  }

  async getVersion(
    workspaceId: string,
    workflowId: string,
    version: number,
  ): Promise<VersionDetail> {
    const workflow = await this.findWorkflow(workspaceId, workflowId);
    const found = await this.prisma.workflowVersion.findFirst({
      where: { workflowId, workspaceId, version },
      select: { ...VERSION_SUMMARY_SELECT, definition: true },
    });
    if (!found) throw new NotFoundException('Version not found');
    return { ...found, isActive: found.id === workflow.activeVersionId };
  }

  private async findWorkflow(workspaceId: string, id: string) {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id, workspaceId },
      select: { id: true, activeVersionId: true },
    });
    if (!workflow) throw new NotFoundException('Workflow not found');
    return workflow;
  }
}
