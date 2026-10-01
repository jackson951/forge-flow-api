import { Injectable } from '@nestjs/common';
import { Workspace, WorkspaceRole } from '@prisma/client';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { WorkspaceResponseDto } from './dto/workspace.dto';

const toResponse = (workspace: Workspace, role: WorkspaceRole): WorkspaceResponseDto => ({
  id: workspace.id,
  name: workspace.name,
  role,
  createdAt: workspace.createdAt,
  updatedAt: workspace.updatedAt,
});

/**
 * Workspace lifecycle. Callers of the `:workspaceId` methods have already passed the
 * WorkspaceAccessGuard; every query is still scoped by the verified workspace id.
 */
@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(userId: string, name: string): Promise<WorkspaceResponseDto> {
    const workspace = await this.prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({
        data: { name, members: { create: { userId, role: WorkspaceRole.OWNER } } },
      });
      await this.audit.record(
        { action: 'workspace.created', workspaceId: created.id, actorUserId: userId },
        tx,
      );
      return created;
    });
    return toResponse(workspace, WorkspaceRole.OWNER);
  }

  /** Only workspaces the user is a member of. */
  async listForUser(userId: string): Promise<WorkspaceResponseDto[]> {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => toResponse(m.workspace, m.role));
  }

  async get(access: WorkspaceAccess): Promise<WorkspaceResponseDto> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: access.workspaceId },
    });
    return toResponse(workspace, access.role);
  }

  async rename(access: WorkspaceAccess, name: string): Promise<WorkspaceResponseDto> {
    const workspace = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.workspace.update({
        where: { id: access.workspaceId },
        data: { name },
      });
      await this.audit.record(
        {
          action: 'workspace.renamed',
          workspaceId: access.workspaceId,
          actorUserId: access.userId,
          metadata: { name },
        },
        tx,
      );
      return updated;
    });
    return toResponse(workspace, access.role);
  }

  /** Deletes the workspace and (by cascade) everything it owns. */
  async delete(access: WorkspaceAccess): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.workspace.delete({ where: { id: access.workspaceId } });
      // Recorded without workspaceId: the workspace's own audit rows are deleted with it.
      await this.audit.record(
        {
          action: 'workspace.deleted',
          actorUserId: access.userId,
          targetType: 'Workspace',
          targetId: access.workspaceId,
        },
        tx,
      );
    });
  }
}
