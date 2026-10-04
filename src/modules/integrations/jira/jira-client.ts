import { Injectable } from '@nestjs/common';
import { ErrorCategory } from '@prisma/client';
import { providerNetworkError } from '../../../common/http/fetch-failure';
import { AppConfigService } from '../../../config/app-config.service';
import { ExecutionError, PermanentError, RetryableError } from '../../../engine/errors';

/** Every Atlassian call is aborted after this (Part 18: ≤ 30 s). */
export const JIRA_TIMEOUT_MS = 15_000;

/**
 * Scopes requested on connect (least privilege, FR-25.1):
 * - read:jira-work / write:jira-work — read issues and projects; create, edit, comment, transition;
 * - read:jira-user — assignable users for the assignee picker and issue people fields;
 * - manage:jira-webhook — register, refresh and delete the dynamic webhooks for triggers;
 * - read:me — the Atlassian account id, the connection's identity;
 * - offline_access — a refresh token (rotating).
 */
export const JIRA_SCOPES = [
  'read:jira-work',
  'write:jira-work',
  'read:jira-user',
  'manage:jira-webhook',
  'read:me',
  'offline_access',
];

/** Events registered for triggers: created and updated (transitions are updates with a status change). */
export const JIRA_WEBHOOK_EVENTS = ['jira:issue_created', 'jira:issue_updated'];

/** Atlassian no longer accepts the user's grant (refresh token expired / revoked). */
export class JiraConsentError extends PermanentError {
  constructor(message: string) {
    super(ErrorCategory.PROVIDER_AUTH, message);
  }
}

/** FlowForge's own Atlassian app credentials were rejected. */
export class JiraAppCredentialsError extends PermanentError {
  constructor(message: string) {
    super(ErrorCategory.PROVIDER_AUTH, message);
  }
}

/** Jira rejected the access token (401): worth one forced refresh. */
export class JiraUnauthorizedError extends PermanentError {
  constructor(message: string) {
    super(ErrorCategory.PROVIDER_AUTH, message);
  }
}

export interface JiraTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scopes: string[];
}

export interface JiraSite {
  cloudId: string;
  name: string;
  url: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  summary: string | null;
  description: string | null;
  status: string | null;
  statusCategory: string | null;
  type: string | null;
  priority: string | null;
  project: { key: string | null; name: string | null };
  assignee: { accountId: string; displayName: string | null } | null;
  reporter: { accountId: string; displayName: string | null } | null;
  labels: string[];
  url: string | null;
  created: string | null;
  updated: string | null;
}

/** Longest description / comment text kept in outputs (untrusted text, size-limited). */
export const MAX_TEXT = 4_000;

/**
 * Atlassian OAuth 2.0 (3LO) and Jira Cloud REST v3 (`/ex/jira/{cloudId}/rest/api/3/...`),
 * with plain `fetch`. The base URLs are server configuration, never user input. Tokens are
 * never logged or put into error messages.
 */
@Injectable()
export class JiraClient {
  constructor(private readonly config: AppConfigService) {}

  isConfigured(): boolean {
    const { clientId, clientSecret } = this.config.jira;
    return Boolean(clientId && clientSecret && this.config.get('OAUTH_REDIRECT_BASE_URL'));
  }

  redirectUri(): string {
    return `${this.config.get('OAUTH_REDIRECT_BASE_URL')!.replace(/\/$/, '')}/jira/callback`;
  }

  authorizeUrl(state: string): string {
    const url = new URL(`${this.config.jira.authUrl}/authorize`);
    url.search = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: this.config.jira.clientId!,
      scope: JIRA_SCOPES.join(' '),
      redirect_uri: this.redirectUri(),
      state,
      response_type: 'code',
      prompt: 'consent',
    }).toString();
    return url.toString();
  }

  exchangeCode(code: string): Promise<JiraTokens> {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri() });
  }

  refresh(refreshToken: string): Promise<JiraTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** The Atlassian account behind the token. */
  async me(
    accessToken: string,
  ): Promise<{ accountId: string; name: string | null; email: string | null }> {
    const body = await this.call<Record<string, unknown>>(
      accessToken,
      'GET',
      `${this.config.jira.apiUrl}/me`,
    );
    if (typeof body.account_id !== 'string' || !body.account_id) {
      throw new PermanentError(
        ErrorCategory.PERMANENT_PROVIDER_ERROR,
        'Atlassian returned no account id',
      );
    }
    return { accountId: body.account_id, name: str(body.name), email: str(body.email) };
  }

  /** Jira sites the grant covers. */
  async sites(accessToken: string): Promise<JiraSite[]> {
    const body = await this.call<unknown[]>(
      accessToken,
      'GET',
      `${this.config.jira.apiUrl}/oauth/token/accessible-resources`,
    );
    return (Array.isArray(body) ? body : [])
      .map((r) => r as Record<string, unknown>)
      .filter(
        (r) =>
          typeof r.id === 'string' &&
          Array.isArray(r.scopes) &&
          (r.scopes as unknown[]).some((s) => typeof s === 'string' && s.includes('jira-work')),
      )
      .map((r) => ({
        cloudId: String(r.id),
        name: str(r.name) ?? String(r.id),
        url: str(r.url) ?? '',
      }));
  }

  // ── Jira REST v3 ────────────────────────────────────────────────────────────

  /** A Jira REST call on one site. `write`: may have changed something (for error mapping). */
  jira<T>(
    accessToken: string,
    cloudId: string,
    method: string,
    path: string,
    json?: unknown,
    { write = false } = {},
  ): Promise<T> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(cloudId)) {
      throw new PermanentError(ErrorCategory.VALIDATION, 'Invalid Jira site id');
    }
    return this.call<T>(
      accessToken,
      method,
      `${this.config.jira.apiUrl}/ex/jira/${cloudId}/rest/api/3${path}`,
      json,
      write,
    );
  }

  /** Dynamic webhook for an OAuth 2.0 app (expires after 30 days). Returns the webhook ids. */
  async registerWebhook(
    accessToken: string,
    cloudId: string,
    url: string,
    jqlFilter: string,
  ): Promise<string[]> {
    const body = await this.jira<{
      webhookRegistrationResult?: { createdWebhookId?: number; errors?: unknown[] }[];
    }>(
      accessToken,
      cloudId,
      'POST',
      '/webhook',
      { url, webhooks: [{ events: JIRA_WEBHOOK_EVENTS, jqlFilter }] },
      { write: true },
    );
    const results = body.webhookRegistrationResult ?? [];
    const ids = results
      .map((r) => r.createdWebhookId)
      .filter((id): id is number => typeof id === 'number');
    if (!ids.length) {
      const errors = results.flatMap((r) => r.errors ?? []).filter((e) => typeof e === 'string');
      throw new PermanentError(
        ErrorCategory.PERMANENT_PROVIDER_ERROR,
        `Jira did not register the webhook${errors.length ? `: ${errors.join('; ').slice(0, 300)}` : ''}`,
      );
    }
    return ids.map(String);
  }

  /** Extends the webhooks by 30 days; returns Jira's new expiry. */
  async refreshWebhooks(accessToken: string, cloudId: string, ids: string[]): Promise<Date> {
    const body = await this.jira<{ expirationDate?: string | number }>(
      accessToken,
      cloudId,
      'PUT',
      '/webhook/refresh',
      { webhookIds: ids.map(Number) },
      { write: true },
    );
    const parsed =
      body.expirationDate === undefined ? NaN : new Date(body.expirationDate).getTime();
    return Number.isFinite(parsed) ? new Date(parsed) : new Date(Date.now() + 30 * 86_400_000);
  }

  async deleteWebhooks(accessToken: string, cloudId: string, ids: string[]): Promise<void> {
    await this.jira(
      accessToken,
      cloudId,
      'DELETE',
      '/webhook',
      { webhookIds: ids.map(Number) },
      { write: true },
    );
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async token(params: Record<string, string>): Promise<JiraTokens> {
    let res: Response;
    try {
      res = await fetch(`${this.config.jira.authUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          ...params,
          client_id: this.config.jira.clientId,
          client_secret: this.config.jira.clientSecret,
        }),
        signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
      });
    } catch (err) {
      throw providerNetworkError(err, { provider: 'Atlassian sign-in', sideEffect: false });
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.access_token !== 'string')
      throw mapTokenError(res.status, res.headers, body);
    const expiresIn = Number(body.expires_in);
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
      expiresAt: new Date(Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3_600) * 1_000),
      scopes: String(body.scope ?? '')
        .split(' ')
        .filter(Boolean),
    };
  }

  private async call<T>(
    accessToken: string,
    method: string,
    url: string,
    json?: unknown,
    write = false,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
          ...(json !== undefined && { 'content-type': 'application/json' }),
        },
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
      });
    } catch (err) {
      throw providerNetworkError(err, { provider: 'Jira', sideEffect: write });
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw mapJiraError(res.status, res.headers, body, write);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text().catch(() => '');
    try {
      return (text ? JSON.parse(text) : undefined) as T;
    } catch {
      throw new PermanentError(
        ErrorCategory.PERMANENT_PROVIDER_ERROR,
        'Jira returned an unreadable response',
      );
    }
  }
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

const retryAfterMs = (headers: Headers) => {
  const seconds = Number(headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1_000, 3_600_000) : undefined;
};

const safeCode = (code: unknown) =>
  typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : 'unknown_error';

/** Token endpoint errors. Atlassian answers an expired/revoked refresh token with 403 or `invalid_grant`. */
export function mapTokenError(
  status: number,
  headers: Headers,
  body: Record<string, unknown>,
): ExecutionError {
  const code = safeCode(body.error);
  if (code === 'invalid_client') {
    return new JiraAppCredentialsError(
      "Atlassian rejected FlowForge's app credentials; check the client secret",
    );
  }
  if (code === 'invalid_grant' || code === 'access_denied' || status === 403) {
    return new JiraConsentError(
      `Atlassian no longer accepts this connection (${code}); reconnect Jira`,
    );
  }
  if (status === 429) {
    return new RetryableError(
      ErrorCategory.PROVIDER_RATE_LIMIT,
      'Atlassian sign-in throttled',
      retryAfterMs(headers) ?? 30_000,
    );
  }
  if (status >= 500) {
    return new RetryableError(
      ErrorCategory.TRANSIENT_INFRASTRUCTURE,
      `Atlassian sign-in unavailable (${status})`,
      retryAfterMs(headers),
    );
  }
  return new PermanentError(
    ErrorCategory.PERMANENT_PROVIDER_ERROR,
    `Atlassian sign-in failed (${code})`,
  );
}

/** Jira's own validation messages, without echoing anything else (FR error handling). */
function jiraMessages(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.errorMessages)
    ? body.errorMessages.filter((m): m is string => typeof m === 'string')
    : [];
  const fields =
    body.errors && typeof body.errors === 'object'
      ? Object.entries(body.errors as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'string')
          .map(([k, v]) => `${k}: ${v}`)
      : [];
  return [...messages, ...fields].join('; ').slice(0, 300);
}

/**
 * Jira HTTP errors (Part 25 error table): 401 → one forced refresh; 403 → AUTHORIZATION;
 * 404 / 409 → permanent; 400 → VALIDATION with Jira's field messages; 429 / 503 → retry with
 * Retry-After; other 5xx → retry for reads, UNCERTAIN_OUTCOME for writes.
 */
export function mapJiraError(
  status: number,
  headers: Headers,
  body: Record<string, unknown>,
  write: boolean,
): ExecutionError {
  const detail = jiraMessages(body);
  const suffix = detail ? `: ${detail}` : '';
  if (status === 401) return new JiraUnauthorizedError('Jira rejected the access token');
  if (status === 403) {
    return new PermanentError(
      ErrorCategory.AUTHORIZATION,
      `Jira denied access (permission or scope missing)${suffix}`,
    );
  }
  if (status === 404) {
    return new PermanentError(
      ErrorCategory.PERMANENT_PROVIDER_ERROR,
      `Jira: not found or no access${suffix}`,
    );
  }
  if (status === 400)
    return new PermanentError(ErrorCategory.VALIDATION, `Jira rejected the request${suffix}`);
  if (status === 429) {
    return new RetryableError(
      ErrorCategory.PROVIDER_RATE_LIMIT,
      'Jira rate limit reached',
      retryAfterMs(headers) ?? 30_000,
    );
  }
  if (status === 503) {
    return new RetryableError(
      ErrorCategory.TRANSIENT_INFRASTRUCTURE,
      'Jira is unavailable (503)',
      retryAfterMs(headers),
    );
  }
  if (status >= 500) {
    return write
      ? new PermanentError(
          ErrorCategory.UNCERTAIN_OUTCOME,
          `Jira returned ${status} after the change was sent; it may have been applied`,
        )
      : new RetryableError(ErrorCategory.TRANSIENT_INFRASTRUCTURE, `Jira returned ${status}`);
  }
  return new PermanentError(
    ErrorCategory.PERMANENT_PROVIDER_ERROR,
    `Jira rejected the request (${status})${suffix}`,
  );
}

// ── Atlassian Document Format ────────────────────────────────────────────────

/** Plain text → ADF: paragraphs on blank lines, line breaks kept. */
export function textToAdf(text: string): Record<string, unknown> {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .filter((p) => p.trim().length > 0);
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: p
        .split('\n')
        .flatMap((line, i) => [
          ...(i > 0 ? [{ type: 'hardBreak' }] : []),
          ...(line ? [{ type: 'text', text: line }] : []),
        ]),
    })),
  };
}

/** ADF (or plain string) → text, capped at `max` characters. Unknown nodes contribute their text. */
export function adfToText(value: unknown, max = MAX_TEXT): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, max);
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object' || out.join('').length > max) return;
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === 'text' && typeof n.text === 'string') out.push(n.text);
    if (n.type === 'hardBreak') out.push('\n');
    if (Array.isArray(n.content)) n.content.forEach(walk);
    if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem') out.push('\n');
  };
  walk(value);
  return out.join('').trim().slice(0, max) || null;
}

/** A Jira issue (REST v3 shape) → the normalised issue used by triggers and actions. */
export function normalizeIssue(raw: unknown, siteUrl?: string): JiraIssue {
  const r = (raw ?? {}) as Record<string, unknown>;
  const f = (r.fields ?? {}) as Record<string, unknown>;
  const name = (v: unknown) => str((v as { name?: unknown } | null)?.name);
  const person = (v: unknown) => {
    const p = v as { accountId?: unknown; displayName?: unknown } | null;
    return p && typeof p.accountId === 'string'
      ? { accountId: p.accountId, displayName: str(p.displayName) }
      : null;
  };
  const status = f.status as { name?: unknown; statusCategory?: { key?: unknown } } | undefined;
  const project = f.project as { key?: unknown; name?: unknown } | undefined;
  const key = str(r.key) ?? '';
  return {
    id: String(r.id ?? ''),
    key,
    summary: str(f.summary),
    description: adfToText(f.description),
    status: name(status),
    statusCategory: str(status?.statusCategory?.key),
    type: name(f.issuetype),
    priority: name(f.priority),
    project: { key: str(project?.key), name: str(project?.name) },
    assignee: person(f.assignee),
    reporter: person(f.reporter),
    labels: Array.isArray(f.labels)
      ? f.labels.filter((l): l is string => typeof l === 'string').slice(0, 50)
      : [],
    url: siteUrl && key ? `${siteUrl.replace(/\/+$/, '')}/browse/${key}` : null,
    created: str(f.created),
    updated: str(f.updated),
  };
}
