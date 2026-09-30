import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';

const ctx = {
  getHandler: () => undefined,
  getClass: () => undefined,
} as unknown as ExecutionContext;

describe('AuthGuard', () => {
  it('allows @Public routes', () => {
    const reflector = { getAllAndOverride: () => true } as unknown as Reflector;
    expect(new AuthGuard(reflector).canActivate(ctx)).toBe(true);
  });

  it('rejects everything else by default', () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    expect(() => new AuthGuard(reflector).canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
