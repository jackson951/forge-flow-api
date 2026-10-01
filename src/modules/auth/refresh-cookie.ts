import { CookieOptions, Request, Response } from 'express';

export const REFRESH_COOKIE = 'ff_refresh';

/** HttpOnly + SameSite=Strict, scoped to the auth routes so it is never sent elsewhere. */
export function refreshCookieOptions(path: string, maxAgeMs?: number): CookieOptions {
  return { httpOnly: true, secure: true, sameSite: 'strict', path, maxAge: maxAgeMs };
}

export function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function clearRefreshCookie(res: Response, path: string): void {
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(path));
}
