import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Enforces that the authenticated user belongs to the workspace owning
 * the requested resource. Applied per-controller once implemented.
 */
@Injectable()
export class WorkspaceAccessGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    // TODO: resolve workspace membership + role
    return false;
  }
}
