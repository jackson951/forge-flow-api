import { Injectable } from '@nestjs/common';
import { ErrorCategory } from '@prisma/client';
import { createSign } from 'node:crypto';
import { AppConfigService } from '../../../config/app-config.service';
import { ExecutionError, PermanentError, RetryableError } from '../../../engine/errors';

/** Every GitHub call is aborted after this (Part 18: ≤ 30 s). */
export const GITHUB_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export interface GitHubInstallation {
  id: number;
  account: { login: string; type: string };
  repository_selection?: string;
}

export interface GitHubRepository {
  fullName: string;
  private: boolean;
}

/**
 * Minimal GitHub App client (no SDK): app JWT (RS256), installation tokens cached in memory
 * until shortly before expiry, user-to-server code exchange. Tokens are never persisted or
 * logged. Every call has a timeout, and failures are mapped to execution error categories.
 */
@Injectable()
export class GitHubClient {
  private readonly installationTokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(private readonly config: AppConfigService) {}

  isConfigured(): boolean {
    return [
      'GITHUB_APP_ID',
      'GITHUB_APP_SLUG',
      'GITHUB_APP_PRIVATE_KEY',
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
      'GITHUB_WEBHOOK_SECRET',
    ].every((k) => Boolean(this.config.get(k as never)));
  }

  installUrl(state: string): string {
    const slug = this.config.get('GITHUB_APP_SLUG')!;
    return `${this.config.get('GITHUB_WEB_URL')}/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /** Exchanges the OAuth code from the install redirect for a short-lived user token. */
  async exchangeUserCode(code: string): Promise<string> {
    const res = await this.fetch(`${this.config.get('GITHUB_WEB_URL')}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.get('GITHUB_CLIENT_ID'),
        client_secret: this.config.get('GITHUB_CLIENT_SECRET'),
        code,
      }),
    });
    const body = (await res.json()) as { access_token?: string; error?: string };
    if (!res.ok || !body.access_token) {
      throw new PermanentError(
        ErrorCategory.PROVIDER_AUTH,
        'GitHub rejected the authorization code',
      );
    }
    return body.access_token;
  }

  /** Installation ids the user can access (proves they may connect that installation). */
  async userInstallationIds(userToken: string): Promise<Set<number>> {
    const ids = new Set<number>();
    for (let page = 1; page <= 10; page++) {
      const body = await this.api<{ installations: { id: number }[] }>(
        `/user/installations?per_page=100&page=${page}`,
        `token ${userToken}`,
      );
      body.installations.forEach((i) => ids.add(i.id));
      if (body.installations.length < 100) break;
    }
    return ids;
  }

  getInstallation(installationId: number): Promise<GitHubInstallation> {
    return this.api(`/app/installations/${installationId}`, `Bearer ${this.appJwt()}`);
  }

  async listRepositories(installationId: number): Promise<GitHubRepository[]> {
    const token = await this.installationToken(installationId);
    const repos: GitHubRepository[] = [];
    for (let page = 1; page <= 10; page++) {
      const body = await this.api<{ repositories: { full_name: string; private: boolean }[] }>(
        `/installation/repositories?per_page=100&page=${page}`,
        `token ${token}`,
      );
      repos.push(...body.repositories.map((r) => ({ fullName: r.full_name, private: r.private })));
      if (body.repositories.length < 100) break;
    }
    return repos;
  }

  /** Short-lived installation token, cached in memory only. */
  async installationToken(installationId: number): Promise<string> {
    const cached = this.installationTokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) return cached.token;

    const body = await this.api<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      `Bearer ${this.appJwt()}`,
      'POST',
    );
    this.installationTokens.set(installationId, {
      token: body.token,
      expiresAt: Date.parse(body.expires_at),
    });
    return body.token;
  }

  /** RS256 JWT identifying the app (valid 9 minutes, backdated 60 s for clock skew). */
  appJwt(now = Math.floor(Date.now() / 1000)): string {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iat: now - 60,
      exp: now + 540,
      iss: this.config.get('GITHUB_APP_ID'),
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(this.privateKey(), 'base64url');
    return `${unsigned}.${signature}`;
  }

  private privateKey(): string {
    const raw = this.config.get('GITHUB_APP_PRIVATE_KEY') ?? '';
    const pem = raw.includes('BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return pem.replace(/\\n/g, '\n');
  }

  private async api<T>(path: string, authorization: string, method = 'GET'): Promise<T> {
    const res = await this.fetch(`${this.config.get('GITHUB_API_URL')}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'FlowForge',
      },
    });
    if (!res.ok) throw mapGitHubError(res.status, res.headers);
    return (await res.json()) as T;
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
    } catch (err) {
      const timedOut = (err as Error).name === 'TimeoutError';
      throw new RetryableError(
        ErrorCategory.PROVIDER_TIMEOUT,
        timedOut ? 'GitHub did not respond in time' : 'Could not reach GitHub',
      );
    }
  }
}

/**
 * GitHub status → execution error. Rate limits are 429, or 403 with
 * `x-ratelimit-remaining: 0` (primary) or `retry-after` (secondary).
 */
export function mapGitHubError(status: number, headers: Headers): ExecutionError {
  const retryAfter = Number(headers.get('retry-after'));
  const reset = Number(headers.get('x-ratelimit-reset'));
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after')));

  if (rateLimited) {
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Number.isFinite(reset) && reset > 0
          ? Math.max(0, reset * 1000 - Date.now())
          : 60_000;
    return new RetryableError(
      ErrorCategory.PROVIDER_RATE_LIMIT,
      'GitHub rate limit reached',
      waitMs,
    );
  }
  if (status === 401 || status === 403) {
    return new PermanentError(
      ErrorCategory.PROVIDER_AUTH,
      'GitHub refused access (installation removed, suspended or missing permissions)',
    );
  }
  if (status >= 500) {
    return new RetryableError(ErrorCategory.TRANSIENT_INFRASTRUCTURE, `GitHub returned ${status}`);
  }
  return new PermanentError(ErrorCategory.PERMANENT_PROVIDER_ERROR, `GitHub returned ${status}`);
}
