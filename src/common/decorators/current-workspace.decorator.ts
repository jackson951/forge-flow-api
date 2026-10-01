import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { WorkspaceAccess } from '../interfaces/workspace-access.interface';

/** The verified workspace membership of the caller. Only valid on `:workspaceId` routes. */
export const CurrentWorkspace = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): WorkspaceAccess => {
    const access = ctx.switchToHttp().getRequest<{ workspace?: WorkspaceAccess }>().workspace;
    // Reaching a handler without it would mean the guard did not run: fail closed.
    if (!access) throw new InternalServerErrorException('Workspace access was not resolved');
    return access;
  },
);
