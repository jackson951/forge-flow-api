import {
  ExecutionContext,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { WorkspacePolicy } from '../../modules/workspaces/workspace-policy';
import { WorkspaceAccessGuard } from './workspace-access.guard';

const WS = '6f1c2f4e-1111-4222-8333-944455556666';

function setup(opts: {
  params?: Record<string, string>;
  required?: WorkspaceRole;
  membership?: { role: WorkspaceRole } | null;
  userId?: string;
}) {
  const findUnique = jest.fn().mockResolvedValue(opts.membership ?? null);
  const prisma = { workspaceMember: { findUnique } } as unknown as PrismaService;
  const reflector = { getAllAndOverride: () => opts.required } as unknown as Reflector;
  const request: Record<string, unknown> = {
    params: opts.params ?? {},
    user: opts.userId === undefined ? { userId: 'user-1' } : { userId: opts.userId },
  };
  const ctx = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const guard = new WorkspaceAccessGuard(reflector, prisma, new WorkspacePolicy());
  return { guard, ctx, request, findUnique };
}

describe('WorkspaceAccessGuard', () => {
  it('ignores routes without :workspaceId', async () => {
    const { guard, ctx, findUnique } = setup({});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('fails closed when @RequireRole is used on a route without :workspaceId', async () => {
    const { guard, ctx } = setup({ required: 'ADMIN' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(InternalServerErrorException);
  });

  it('attaches the membership for a member', async () => {
    const { guard, ctx, request, findUnique } = setup({
      params: { workspaceId: WS },
      membership: { role: 'MEMBER' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_userId: { workspaceId: WS, userId: 'user-1' } },
      }),
    );
    expect(request.workspace).toEqual({ workspaceId: WS, userId: 'user-1', role: 'MEMBER' });
  });

  it('returns 404 for non-members', async () => {
    const { guard, ctx } = setup({ params: { workspaceId: WS }, membership: null });
    await expect(guard.canActivate(ctx)).rejects.toThrow(NotFoundException);
  });

  it('returns 404 for a malformed id without querying', async () => {
    const { guard, ctx, findUnique } = setup({ params: { workspaceId: 'not-a-uuid' } });
    await expect(guard.canActivate(ctx)).rejects.toThrow(NotFoundException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns 403 when the role is insufficient', async () => {
    const { guard, ctx } = setup({
      params: { workspaceId: WS },
      required: 'ADMIN',
      membership: { role: 'MEMBER' },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('allows a higher role than required', async () => {
    const { guard, ctx } = setup({
      params: { workspaceId: WS },
      required: 'ADMIN',
      membership: { role: 'OWNER' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
