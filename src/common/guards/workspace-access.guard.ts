import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WorkspaceRole } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { WorkspacePolicy } from '../../modules/workspaces/workspace-policy';
import { REQUIRED_ROLE_KEY } from '../decorators/require-role.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { WorkspaceAccess } from '../interfaces/workspace-access.interface';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type GuardedRequest = Request & { user?: AuthenticatedUser; workspace?: WorkspaceAccess };

/**
 * Global tenant guard. Every route with a `:workspaceId` parameter is checked automatically,
 * so a new controller cannot forget it:
 * - not a member (or not a valid id)      → 404, so other workspaces' existence is not revealed
 * - member without the @RequireRole role  → 403
 * Membership is re-read on every request (one indexed lookup), so role changes and removals
 * take effect immediately.
 */
@Injectable()
export class WorkspaceAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly policy: WorkspacePolicy,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<WorkspaceRole | undefined>(
      REQUIRED_ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const request = context.switchToHttp().getRequest<GuardedRequest>();
    const workspaceId = request.params?.workspaceId;

    if (workspaceId === undefined) {
      // A role requirement on a route without a workspace can never be satisfied: fail closed.
      if (required)
        throw new InternalServerErrorException('@RequireRole needs a :workspaceId route');
      return true;
    }

    const userId = request.user?.userId;
    if (!userId || typeof workspaceId !== 'string' || !UUID.test(workspaceId)) {
      throw new NotFoundException('Workspace not found');
    }

    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!membership) throw new NotFoundException('Workspace not found');

    if (required && !this.policy.hasRole(membership.role, required)) {
      throw new ForbiddenException(`Requires ${required} role in this workspace`);
    }

    request.workspace = { workspaceId, userId, role: membership.role };
    return true;
  }
}
