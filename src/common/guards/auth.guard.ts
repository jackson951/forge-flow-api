import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { TokenService } from '../../modules/auth/token.service';
import { IS_PUBLIC_KEY } from '../constants';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/**
 * Global authentication guard — secure by default. Routes marked @Public() pass;
 * everything else needs a valid `Authorization: Bearer <access token>`.
 * Stateless: no database lookup on the hot path.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    const claims =
      scheme?.toLowerCase() === 'bearer' && token ? this.tokens.verifyAccessToken(token) : null;
    if (!claims) throw new UnauthorizedException('Invalid or missing access token');

    request.user = { userId: claims.userId };
    return true;
  }
}
