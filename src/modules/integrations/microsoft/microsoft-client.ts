import { Injectable } from '@nestjs/common';
import { ErrorCategory } from '@prisma/client';
import { AppConfigService } from '../../../config/app-config.service';
import { ExecutionError, PermanentError, RetryableError } from '../../../engine/errors';

const TIMEOUT_MS = 15_000;
const MAX_LIST_PAGES = 10;

/** Delegated scopes requested on connect — least privilege (Part 14). Nothing else. */
export const MICROSOFT_SCOPES = [
  'openid',
  'profile',
  'offline_access',
  'User.Read',
  'Tasks.ReadWrite',
];

/** Microsoft's error for a refresh token or consent that no longer works. */
export class MicrosoftConsentError extends PermanentError {
  constructor(message: string) {
    super(ErrorCategory.PROVIDER_AUTH, message);
  }
}

/** FlowForge's own app registration was rejected (e.g. expired client secret). */
export class MicrosoftAppCredentialsError extends PermanentError {
  constructor(message: string) {
    super(ErrorCategory.PROVIDER_AUTH, message);
  }
}

/** Graph rejected the access token (401): worth one forced refresh. */
export class GraphUnauthorizedError extends PermanentError {
  constructor(message: string) {
    super(ErrorCategory.PROVIDER_AUTH, message);
  }
}

export interface MicrosoftTokens {
  accessToken: string;
  /** Absent when Microsoft did not rotate it (keep the old one). */
  refreshToken?: string;
  expiresAt: Date;
  scopes: string[];
  /** Raw id_token, for display metadata only. */
  idToken?: string;
}

export interface MicrosoftProfile {
  id: string;
  displayName: string | null;
  userPrincipalName: string | null;
  mail: string | null;
}

export interface TodoList {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export interface NewTodoTask {
  title: string;
  body?: string;
  /** YYYY-MM-DD */
  dueDate?: string;
}

/**
 * Microsoft identity platform (v2 endpoints) and Graph, with plain `fetch` (no MSAL: FlowForge
 * stores and refreshes tokens itself, encrypted). 15 s timeouts; failures map to execution
 * error categories. Tokens are never logged or put into error messages; Graph `request-id`s
 * are included in error messages for diagnostics.
 */
@Injectable()
export class MicrosoftClient {
  constructor(private readonly config: AppConfigService) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.get('MICROSOFT_CLIENT_ID') &&
      this.config.get('MICROSOFT_CLIENT_SECRET') &&
      this.config.get('OAUTH_REDIRECT_BASE_URL'),
    );
  }

  redirectUri(): string {
    return `${this.config.get('OAUTH_REDIRECT_BASE_URL')!.replace(/\/$/, '')}/microsoft/callback`;
  }

  authorizeUrl(state: string, codeChallenge: string): string {
    const url = new URL(`${this.authority()}/oauth2/v2.0/authorize`);
    url.search = new URLSearchParams({
      client_id: this.config.get('MICROSOFT_CLIENT_ID')!,
      response_type: 'code',
      redirect_uri: this.redirectUri(),
      response_mode: 'query',
      scope: MICROSOFT_SCOPES.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  exchangeCode(code: string, codeVerifier: string): Promise<MicrosoftTokens> {
    return this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri(),
      code_verifier: codeVerifier,
    });
  }

  refresh(refreshToken: string): Promise<MicrosoftTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async me(accessToken: string): Promise<MicrosoftProfile> {
    const body = await this.graph<Record<string, unknown>>(
      accessToken,
      'GET',
      '/me?$select=id,displayName,userPrincipalName,mail',
    );
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    if (!str(body.id)) {
      throw new PermanentError(
        ErrorCategory.PERMANENT_PROVIDER_ERROR,
        'Microsoft returned no user id',
      );
    }
    return {
      id: String(body.id),
      displayName: str(body.displayName),
      userPrincipalName: str(body.userPrincipalName),
      mail: str(body.mail),
    };
  }

  /** All To Do lists (follows `@odata.nextLink`, which must stay on the Graph host). */
  async todoLists(accessToken: string): Promise<TodoList[]> {
    const lists: TodoList[] = [];
    let path: string | null = '/me/todo/lists?$select=id,displayName,wellknownListName';
    for (let page = 0; path && page < MAX_LIST_PAGES; page++) {
      const body: { value?: Record<string, unknown>[]; '@odata.nextLink'?: string } =
        await this.graph(accessToken, 'GET', path);
      for (const l of body.value ?? []) {
        lists.push({
          id: String(l.id),
          displayName: String(l.displayName ?? ''),
          isDefault: l.wellknownListName === 'defaultList',
        });
      }
      path = this.relativeNextLink(body['@odata.nextLink']);
    }
    return lists;
  }

  /** Creates a task. Not idempotent (Graph To Do has no idempotency key). */
  async createTask(
    accessToken: string,
    listId: string,
    task: NewTodoTask,
  ): Promise<{ id: string; requestId: string | null }> {
    const { body, requestId } = await this.graphWithMeta<{ id?: string }>(
      accessToken,
      'POST',
      `/me/todo/lists/${encodeURIComponent(listId)}/tasks`,
      {
        title: task.title,
        ...(task.body && { body: { content: task.body, contentType: 'text' } }),
        ...(task.dueDate && {
          dueDateTime: { dateTime: `${task.dueDate}T00:00:00`, timeZone: 'UTC' },
        }),
      },
      { sideEffect: true },
    );
    if (!body.id) {
      throw new PermanentError(
        ErrorCategory.UNCERTAIN_OUTCOME,
        `Microsoft accepted the task but returned no id${requestId ? ` (request-id ${requestId})` : ''}`,
      );
    }
    return { id: body.id, requestId };
  }

  private authority(): string {
    const tenant = encodeURIComponent(this.config.get('MICROSOFT_TENANT_ID'));
    return `${this.config.get('MICROSOFT_LOGIN_URL').replace(/\/$/, '')}/${tenant}`;
  }

  private graphBase(): string {
    return this.config.get('MICROSOFT_GRAPH_URL').replace(/\/$/, '');
  }

  /**
   * Only follow next links on the configured Graph origin and API version: an attacker-
   * influenced URL must never receive the bearer token.
   */
  private relativeNextLink(next: unknown): string | null {
    if (typeof next !== 'string' || !next) return null;
    const base = this.graphBase();
    if (!next.startsWith(`${base}/`)) {
      throw new PermanentError(
        ErrorCategory.PERMANENT_PROVIDER_ERROR,
        'Microsoft Graph returned an unexpected paging link',
      );
    }
    return next.slice(base.length);
  }

  private async token(params: Record<string, string>): Promise<MicrosoftTokens> {
    let res: Response;
    try {
      res = await fetch(`${this.authority()}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.get('MICROSOFT_CLIENT_ID')!,
          client_secret: this.config.get('MICROSOFT_CLIENT_SECRET')!,
          scope: MICROSOFT_SCOPES.join(' '),
          ...params,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw networkError(err, false, 'Microsoft sign-in');
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw mapTokenError(res.status, res.headers, body);

    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new PermanentError(
        ErrorCategory.PERMANENT_PROVIDER_ERROR,
        'Microsoft returned an unexpected token response',
      );
    }
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
      expiresAt: new Date(Date.now() + body.expires_in * 1000),
      scopes: String(body.scope ?? '')
        .split(' ')
        .filter(Boolean),
      idToken: typeof body.id_token === 'string' ? body.id_token : undefined,
    };
  }

  private async graph<T>(
    accessToken: string,
    method: string,
    path: string,
    json?: object,
  ): Promise<T> {
    return (await this.graphWithMeta<T>(accessToken, method, path, json)).body;
  }

  private async graphWithMeta<T>(
    accessToken: string,
    method: string,
    path: string,
    json?: object,
    { sideEffect = false } = {},
  ): Promise<{ body: T; requestId: string | null }> {
    let res: Response;
    try {
      res = await fetch(`${this.graphBase()}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
          ...(json && { 'content-type': 'application/json' }),
        },
        body: json ? JSON.stringify(json) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw networkError(err, sideEffect, 'Microsoft Graph');
    }
    const requestId = res.headers.get('request-id') ?? res.headers.get('client-request-id');
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: unknown } };
      throw mapGraphError(res.status, res.headers, body.error?.code, requestId);
    }
    return { body: (await res.json()) as T, requestId };
  }
}

/** Display metadata from an id_token. NOT verified: never used for authorisation. */
export function idTokenClaims(idToken?: string): { tenantId?: string } {
  try {
    const payload = JSON.parse(Buffer.from(idToken!.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.tid === 'string' ? { tenantId: payload.tid } : {};
  } catch {
    return {};
  }
}

const safeCode = (code: unknown) =>
  typeof code === 'string' && /^[A-Za-z0-9_.]{1,64}$/.test(code) ? code : 'unknown_error';

const retryAfterMs = (headers: Headers) => {
  const seconds = Number(headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
};

function networkError(err: unknown, sideEffect: boolean, what: string): ExecutionError {
  const name = (err as Error)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return sideEffect
      ? new PermanentError(
          ErrorCategory.UNCERTAIN_OUTCOME,
          `${what} did not answer in time; the task may have been created, so it is not retried automatically`,
        )
      : new RetryableError(ErrorCategory.PROVIDER_TIMEOUT, `${what} did not respond in time`);
  }
  return new RetryableError(ErrorCategory.TRANSIENT_INFRASTRUCTURE, `Could not reach ${what}`);
}

/**
 * Token endpoint errors (OAuth 2.0 `error` codes). `invalid_grant` means the user's refresh
 * token or consent no longer works (reconnect). `invalid_client` / `unauthorized_client` mean
 * FlowForge's own app registration is wrong (e.g. expired client secret): not the user's
 * fault, so the connection is not flagged.
 */
export function mapTokenError(
  status: number,
  headers: Headers,
  body: Record<string, unknown>,
): ExecutionError {
  const code = safeCode(body.error);
  if (code === 'invalid_grant' || code === 'interaction_required' || code === 'consent_required') {
    return new MicrosoftConsentError(
      `Microsoft no longer accepts this connection (${code}); reconnect Microsoft`,
    );
  }
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    return new MicrosoftAppCredentialsError(
      `Microsoft rejected FlowForge's app credentials (${code}); check the client secret`,
    );
  }
  if (status === 429 || code === 'temporarily_unavailable' || status >= 500) {
    const wait = retryAfterMs(headers);
    return status === 429
      ? new RetryableError(
          ErrorCategory.PROVIDER_RATE_LIMIT,
          'Microsoft sign-in throttled',
          wait ?? 30_000,
        )
      : new RetryableError(
          ErrorCategory.TRANSIENT_INFRASTRUCTURE,
          `Microsoft sign-in unavailable (${code})`,
          wait,
        );
  }
  return new PermanentError(
    ErrorCategory.PERMANENT_PROVIDER_ERROR,
    `Microsoft sign-in failed (${code})`,
  );
}

/** Graph HTTP errors. 429/503 honour Retry-After (Graph throttling). */
export function mapGraphError(
  status: number,
  headers: Headers,
  errorCode: unknown,
  requestId: string | null,
): ExecutionError {
  const code = safeCode(errorCode);
  const ref = requestId ? `; request-id ${requestId}` : '';
  const wait = retryAfterMs(headers);
  if (status === 429 || (status === 503 && wait)) {
    return new RetryableError(
      ErrorCategory.PROVIDER_RATE_LIMIT,
      `Microsoft Graph throttled the request${ref}`,
      wait ?? 30_000,
    );
  }
  if (status === 401) {
    return new GraphUnauthorizedError(`Microsoft Graph rejected the access token (${code}${ref})`);
  }
  if (status === 403) {
    return new PermanentError(
      ErrorCategory.PROVIDER_AUTH,
      `Microsoft Graph denied access (${code}${ref}); reconnect and grant the requested permissions`,
    );
  }
  if (status === 404) {
    return new PermanentError(
      ErrorCategory.PERMANENT_PROVIDER_ERROR,
      `Microsoft To Do list not found (${code}${ref})`,
    );
  }
  if (status >= 500) {
    return new RetryableError(
      ErrorCategory.TRANSIENT_INFRASTRUCTURE,
      `Microsoft Graph returned ${status} (${code}${ref})`,
      wait,
    );
  }
  return new PermanentError(
    ErrorCategory.PERMANENT_PROVIDER_ERROR,
    `Microsoft Graph rejected the request: ${status} (${code}${ref})`,
  );
}
