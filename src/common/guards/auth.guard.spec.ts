import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TokenService } from '../../modules/auth/token.service';
import { AuthGuard } from './auth.guard';

function context(authorization?: string) {
  const request: { headers: Record<string, string>; user?: unknown } = {
    headers: authorization ? { authorization } : {},
  };
  const ctx = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

describe('AuthGuard', () => {
  const verifyAccessToken = jest.fn();
  const tokens = { verifyAccessToken } as unknown as TokenService;
  const guard = (isPublic: boolean) =>
    new AuthGuard({ getAllAndOverride: () => isPublic } as unknown as Reflector, tokens);

  beforeEach(() => verifyAccessToken.mockReset());

  it('allows @Public routes without a token', () => {
    expect(guard(true).canActivate(context().ctx)).toBe(true);
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it('attaches the user for a valid bearer token', () => {
    verifyAccessToken.mockReturnValue({ userId: 'u-1' });
    const { ctx, request } = context('Bearer good.token');
    expect(guard(false).canActivate(ctx)).toBe(true);
    expect(verifyAccessToken).toHaveBeenCalledWith('good.token');
    expect(request.user).toEqual({ userId: 'u-1' });
  });

  it.each([
    ['no header', undefined],
    ['wrong scheme', 'Basic abc'],
    ['empty token', 'Bearer '],
  ])('rejects %s', (_label, header) => {
    expect(() => guard(false).canActivate(context(header).ctx)).toThrow(UnauthorizedException);
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejects a token that fails verification', () => {
    verifyAccessToken.mockReturnValue(null);
    expect(() => guard(false).canActivate(context('Bearer bad').ctx)).toThrow(
      UnauthorizedException,
    );
  });
});
