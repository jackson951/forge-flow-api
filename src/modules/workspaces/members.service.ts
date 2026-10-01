import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, WorkspaceRole } from '@prisma/client';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MemberResponseDto } from './dto/member.dto';
import { MemberRef, WorkspacePolicy } from './workspace-policy';

const MEMBER_INCLUDE = {
  user: { select: { id: true, email: true, name: true } },
} satisfies Prisma.WorkspaceMemberInclude;

type MemberWithUser = Prisma.WorkspaceMemberGetPayload<{ include: typeof MEMBER_INCLUDE }>;

const toResponse = (m: MemberWithUser): MemberResponseDto => ({
  userId: m.user.id,
  email: m.user.email,
  name: m.user.name,
  role: m.role,
  joinedAt: m.createdAt,
});

const LAST_OWNER = 'A workspace must keep at least one owner';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: WorkspacePolicy,
    private readonly audit: AuditService,
  ) {}

  async list(access: WorkspaceAccess): Promise<MemberResponseDto[]> {
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId: access.workspaceId },
      include: MEMBER_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    return members.map(toResponse);
  }

  async add(
    access: WorkspaceAccess,
    email: string,
    role: WorkspaceRole,
  ): Promise<MemberResponseDto> {
    return this.inWorkspaceLock(access, async (tx, actor) => {
      this.policy.assertCanAdd(actor, role);
      const user = await tx.user.findUnique({ where: { email }, select: { id: true } });
      if (!user) throw new NotFoundException('User not found');

      const existing = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: access.workspaceId, userId: user.id } },
      });
      if (existing) throw new ConflictException('User is already a member of this workspace');

      const member = await tx.workspaceMember.create({
        data: { workspaceId: access.workspaceId, userId: user.id, role },
        include: MEMBER_INCLUDE,
      });
      await this.audit.record(
        {
          action: 'member.added',
          workspaceId: access.workspaceId,
          actorUserId: actor.userId,
          targetType: 'User',
          targetId: user.id,
          metadata: { role },
        },
        tx,
      );
      return toResponse(member);
    });
  }

  async changeRole(
    access: WorkspaceAccess,
    targetUserId: string,
    role: WorkspaceRole,
  ): Promise<MemberResponseDto> {
    return this.inWorkspaceLock(access, async (tx, actor) => {
      const target = await this.findTarget(tx, access.workspaceId, targetUserId);
      this.policy.assertCanChangeRole(actor, target, role);
      if (target.role === 'OWNER' && role !== 'OWNER') {
        await this.assertAnotherOwner(tx, access.workspaceId);
      }

      const member = await tx.workspaceMember.update({
        where: { id: target.id },
        data: { role },
        include: MEMBER_INCLUDE,
      });
      await this.audit.record(
        {
          action: 'member.role_changed',
          workspaceId: access.workspaceId,
          actorUserId: actor.userId,
          targetType: 'User',
          targetId: targetUserId,
          metadata: { from: target.role, to: role },
        },
        tx,
      );
      return toResponse(member);
    });
  }

  async remove(access: WorkspaceAccess, targetUserId: string): Promise<void> {
    await this.inWorkspaceLock(access, async (tx, actor) => {
      const target = await this.findTarget(tx, access.workspaceId, targetUserId);
      this.policy.assertCanRemove(actor, target);
      if (target.role === 'OWNER') await this.assertAnotherOwner(tx, access.workspaceId);

      await tx.workspaceMember.delete({ where: { id: target.id } });
      await this.audit.record(
        {
          action: actor.userId === targetUserId ? 'member.left' : 'member.removed',
          workspaceId: access.workspaceId,
          actorUserId: actor.userId,
          targetType: 'User',
          targetId: targetUserId,
        },
        tx,
      );
    });
  }

  /**
   * Serialises membership changes per workspace (row lock on the workspace) and re-reads the
   * actor's role inside the transaction, so concurrent demotions cannot leave zero owners and
   * a just-demoted actor cannot act on a stale role.
   */
  private inWorkspaceLock<T>(
    access: WorkspaceAccess,
    work: (tx: Prisma.TransactionClient, actor: MemberRef) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${access.workspaceId}::uuid FOR UPDATE`;
      const actor = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: access.workspaceId, userId: access.userId } },
        select: { userId: true, role: true },
      });
      if (!actor) throw new NotFoundException('Workspace not found');
      return work(tx, actor);
    });
  }

  private async findTarget(tx: Prisma.TransactionClient, workspaceId: string, userId: string) {
    const target = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    // Non-members of this workspace are indistinguishable from non-existent users.
    if (!target) throw new NotFoundException('Member not found');
    return target;
  }

  private async assertAnotherOwner(tx: Prisma.TransactionClient, workspaceId: string) {
    const owners = await tx.workspaceMember.count({
      where: { workspaceId, role: WorkspaceRole.OWNER },
    });
    if (owners <= 1) throw new ConflictException(LAST_OWNER);
  }
}
