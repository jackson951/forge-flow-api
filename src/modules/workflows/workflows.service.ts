import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { Prisma, Workflow, WorkflowStatus } from '@prisma/client';
import { Cursor, decodeCursor, encodeCursor } from '../../common/utils/cursor';
import { EMPTY_DEFINITION, WorkflowDefinition } from '../../engine/definition/definition.schema';
import { DefinitionValidatorService } from '../../engine/executor/definition-validator.service';
import { ValidationIssue } from '../../engine/validation/graph-validator';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { ListWorkflowsQueryDto } from './dto/list-workflows-query.dto';
import { SaveDraftDto } from './dto/save-draft.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';

const SUMMARY_SELECT = {
  id: true,
  name: true,
  description: true,
  status: true,
  draftRevision: true,
  createdAt: true,
  updatedAt: true,
  activeVersion: { select: { id: true, version: true, publishedAt: true } },
} satisfies Prisma.WorkflowSelect;

export type WorkflowSummary = Prisma.WorkflowGetPayload<{ select: typeof SUMMARY_SELECT }>;

export interface WorkflowDetail extends WorkflowSummary {
  draftDefinition: WorkflowDefinition;
  issues: ValidationIssue[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/**
 * Workflow metadata and draft lifecycle. Every query is scoped by the workspace id that the
 * WorkspaceAccessGuard verified; a workflow id from another workspace is simply "not found".
 */
@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: DefinitionValidatorService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string, query: ListWorkflowsQueryDto): Promise<Page<WorkflowSummary>> {
    const limit = query.limit ?? 20;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const status: Prisma.WorkflowWhereInput['status'] = query.status
      ? query.status
      : query.includeArchived
        ? undefined
        : { not: WorkflowStatus.ARCHIVED };

    const rows = await this.prisma.workflow.findMany({
      where: { workspaceId, status, ...(cursor && keysetAfter(cursor)) },
      select: SUMMARY_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
  }

  async get(workspaceId: string, id: string): Promise<WorkflowDetail> {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id, workspaceId },
      select: { ...SUMMARY_SELECT, draftDefinition: true },
    });
    if (!workflow) throw notFound();
    const draftDefinition = this.storedDraft(workflow.draftDefinition);
    return { ...workflow, draftDefinition, issues: this.validator.validate(draftDefinition) };
  }

  async create(
    workspaceId: string,
    userId: string,
    dto: CreateWorkflowDto,
  ): Promise<WorkflowDetail> {
    const workflow = await this.prisma.workflow.create({
      data: {
        workspaceId,
        createdById: userId,
        name: dto.name,
        description: dto.description,
        draftDefinition: toJson(EMPTY_DEFINITION),
      },
      select: SUMMARY_SELECT,
    });
    return {
      ...workflow,
      draftDefinition: EMPTY_DEFINITION,
      issues: this.validator.validate(EMPTY_DEFINITION),
    };
  }

  async update(workspaceId: string, id: string, dto: UpdateWorkflowDto): Promise<WorkflowSummary> {
    await this.findOwned(workspaceId, id);
    return this.prisma.workflow.update({
      where: { id },
      data: { name: dto.name, description: dto.description },
      select: SUMMARY_SELECT,
    });
  }

  /**
   * Saves a structurally valid draft, even if it still has graph errors (so work is never
   * lost), and returns the issues. Rejected: malformed shape, size limits, stale revision,
   * archived workflow.
   */
  async saveDraft(
    workspaceId: string,
    id: string,
    dto: SaveDraftDto,
  ): Promise<{ draftRevision: number; issues: ValidationIssue[] }> {
    const definition = this.parseOrThrow(dto.definition);
    const issues = this.validator.validate(definition);
    const limits = issues.filter((i) => i.code === 'LIMIT_EXCEEDED');
    if (limits.length) {
      throw new BadRequestException({
        message: 'Workflow definition is too large',
        details: limits,
      });
    }

    const updated = await this.prisma.workflow.updateMany({
      where: {
        id,
        workspaceId,
        draftRevision: dto.expectedRevision,
        status: { not: WorkflowStatus.ARCHIVED },
      },
      data: { draftDefinition: toJson(definition), draftRevision: { increment: 1 } },
    });
    if (updated.count === 0) {
      const current = await this.findOwned(workspaceId, id);
      if (current.status === WorkflowStatus.ARCHIVED) {
        throw new ConflictException('Archived workflows cannot be edited; unarchive first');
      }
      throw new ConflictException({
        message: 'The draft was changed since you loaded it',
        details: { currentRevision: current.draftRevision },
      });
    }
    return { draftRevision: dto.expectedRevision + 1, issues };
  }

  /** Validates the given definition, or the stored draft when none is given. Never saves. */
  async validate(workspaceId: string, id: string, raw?: unknown): Promise<ValidationResult> {
    const workflow = await this.findOwned(workspaceId, id);
    const definition =
      raw === undefined ? this.storedDraft(workflow.draftDefinition) : this.parseOrThrow(raw);
    const issues = this.validator.validate(definition);
    return { valid: !issues.some((i) => i.severity === 'error'), issues };
  }

  async duplicate(workspaceId: string, userId: string, id: string): Promise<WorkflowDetail> {
    const source = await this.findOwned(workspaceId, id);
    const copy = await this.prisma.workflow.create({
      data: {
        workspaceId,
        createdById: userId,
        name: `Copy of ${source.name}`.slice(0, 120),
        description: source.description,
        draftDefinition: source.draftDefinition as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return this.get(workspaceId, copy.id);
  }

  /** Archived workflows stop triggering (their trigger routing rows are removed). */
  async archive(workspaceId: string, userId: string, id: string): Promise<WorkflowSummary> {
    await this.findOwned(workspaceId, id);
    return this.prisma.$transaction(async (tx) => {
      await tx.workflowTrigger.deleteMany({ where: { workflowId: id } });
      const workflow = await tx.workflow.update({
        where: { id },
        data: { status: WorkflowStatus.ARCHIVED },
        select: SUMMARY_SELECT,
      });
      await this.audit.record(
        {
          action: 'workflow.archived',
          workspaceId,
          actorUserId: userId,
          targetType: 'Workflow',
          targetId: id,
        },
        tx,
      );
      return workflow;
    });
  }

  /**
   * Returns to PUBLISHED if a version is active, otherwise DRAFT. Re-activating triggers for
   * the active version is part of publishing (Part 06).
   */
  async unarchive(workspaceId: string, userId: string, id: string): Promise<WorkflowSummary> {
    const current = await this.findOwned(workspaceId, id);
    return this.prisma.$transaction(async (tx) => {
      const workflow = await tx.workflow.update({
        where: { id },
        data: {
          status: current.activeVersionId ? WorkflowStatus.PUBLISHED : WorkflowStatus.DRAFT,
        },
        select: SUMMARY_SELECT,
      });
      await this.audit.record(
        {
          action: 'workflow.unarchived',
          workspaceId,
          actorUserId: userId,
          targetType: 'Workflow',
          targetId: id,
        },
        tx,
      );
      return workflow;
    });
  }

  /** Hard delete only while no run references the workflow; otherwise archive it. */
  async remove(workspaceId: string, userId: string, id: string): Promise<void> {
    await this.findOwned(workspaceId, id);
    const runs = await this.prisma.workflowRun.count({ where: { workflowId: id } });
    if (runs > 0) throw cannotDeleteWithRuns();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.workflow.delete({ where: { id } });
        await this.audit.record(
          {
            action: 'workflow.deleted',
            workspaceId,
            actorUserId: userId,
            targetType: 'Workflow',
            targetId: id,
          },
          tx,
        );
      });
    } catch (err) {
      // A run created between the count and the delete is caught by the foreign key.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        throw cannotDeleteWithRuns();
      }
      throw err;
    }
  }

  async publish(workspaceId: string, id: string): Promise<never> {
    await this.findOwned(workspaceId, id);
    throw new NotImplementedException('Publishing arrives in Part 06');
  }

  async listVersions(workspaceId: string, id: string): Promise<never> {
    await this.findOwned(workspaceId, id);
    throw new NotImplementedException('Version history arrives in Part 06');
  }

  private async findOwned(workspaceId: string, id: string): Promise<Workflow> {
    const workflow = await this.prisma.workflow.findFirst({ where: { id, workspaceId } });
    if (!workflow) throw notFound();
    return workflow;
  }

  private parseOrThrow(raw: unknown): WorkflowDefinition {
    const parsed = this.validator.parse(raw);
    if (!parsed.ok) {
      throw new BadRequestException({
        message: 'Invalid workflow definition',
        details: parsed.errors,
      });
    }
    return parsed.definition;
  }

  /** Stored drafts were validated on write; a failure here means corrupted data. */
  private storedDraft(raw: Prisma.JsonValue): WorkflowDefinition {
    const parsed = this.validator.parse(raw);
    if (!parsed.ok) throw new Error('Stored workflow draft does not match the definition schema');
    return parsed.definition;
  }
}

function keysetAfter(cursor: Cursor): Prisma.WorkflowWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

const notFound = () => new NotFoundException('Workflow not found');
const cannotDeleteWithRuns = () =>
  new ConflictException('This workflow has run history and cannot be deleted; archive it instead');

/** Definitions are validated JSON; zod's `Record<string, unknown>` just isn't typed as JSON. */
const toJson = (definition: WorkflowDefinition) => definition as unknown as Prisma.InputJsonObject;
