import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../constants';

/**
 * Global authentication guard — secure by default.
 * Routes marked @Public() pass; everything else is rejected until
 * token verification is implemented (Phase 0).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // TODO: verify access token, attach AuthenticatedUser to request.user
    throw new UnauthorizedException();
  }
}
