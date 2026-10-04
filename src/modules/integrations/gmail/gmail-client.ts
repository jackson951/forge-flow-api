import { Injectable } from '@nestjs/common';
import { ErrorCategory } from '@prisma/client';
import { providerNetworkError } from '../../../common/http/fetch-failure';
import { AppConfigService } from '../../../config/app-config.service';
import { ExecutionError, PermanentError, RetryableError } from '../../../engine/errors';
import { GmailMessageResource } from './gmail-mime';

/** Every Google call is aborted after this (Part 18: ≤ 30 s). */
export const GMAIL_TIMEOUT_MS = 15_000;

/**
 * Scopes requested on connect (least privilege for the implemented features, FR-26.1):
 * - gmail.modify — read messages and history (triggers, get), labels and read state; it is the
 *   narrowest scope that covers reading *and* changing labels (Google "restricted" scope);
 * - gmail.send — send and reply ("sensitive" scope);
 * - openid, email — the mailbox address and the Google user id of the connection.
 * Not requested: full mail access (https://mail.google.com/), which would also allow deletion.
 */
export const GMAIL_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
];

export class GmailConsentError extends PermanentError {
  constructor(message: string) {
    super(ErrorCategory.PROVIDER_AUTH, message);
  }
}

export class GmailAppCredentialsError extends PermanentError {
  constructor(message: string) {
    super(ErrorCategory.PROVIDER_AUTH, message);
  }
}

/** Gmail rejected the access token (401): worth one forced refresh. */
export class GmailUnauthorizedError extends PermanentError {
  constructor(message: string) {
    super(ErrorCategory.PROVIDER_AUTH, message);
  }
}

/** startHistoryId is too old (history.list 404): the missed-history procedure applies. */
export class GmailHistoryGoneError extends Error {
  constructor() {
    super('Gmail history is no longer available from the stored history id');
    this.name = 'GmailHistoryGoneError';
  }
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scopes: string[];
}

export interface GmailHistoryPage {
  history: {
    messagesAdded?: { message?: { id?: string; labelIds?: string[] } }[];
    labelsAdded?: { message?: { id?: string; labelIds?: string[] }; labelIds?: string[] }[];
  }[];
  historyId?: string;
  nextPageToken?: string;
}

/**
 * Google OAuth 2.0 and the Gmail REST API v1 with plain `fetch`. Base URLs are server
 * configuration. Tokens, message contents and addresses are never logged or put into errors.
 */
@Injectable()
export class GmailClient {
  constructor(private readonly config: AppConfigService) {}

  isConfigured(): boolean {
    const { clientId, clientSecret } = this.config.gmail;
    return Boolean(clientId && clientSecret && this.config.get('OAUTH_REDIRECT_BASE_URL'));
  }

  /** Triggers additionally need the Pub/Sub topic and push verification settings. */
  triggersConfigured(): boolean {
    const { topic, pushAudience, pushServiceAccount } = this.config.gmail;
    return this.isConfigured() && Boolean(topic && pushAudience && pushServiceAccount);
  }

  redirectUri(): string {
    return `${this.config.get('OAUTH_REDIRECT_BASE_URL')!.replace(/\/$/, '')}/gmail/callback`;
  }

  authorizeUrl(state: string, codeChallenge: string): string {
    const url = new URL(this.config.gmail.authUrl);
    url.search = new URLSearchParams({
      client_id: this.config.gmail.clientId!,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: GMAIL_SCOPES.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    }).toString();
    return url.toString();
  }

  exchangeCode(code: string, codeVerifier: string): Promise<GoogleTokens> {
    return this.token({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.redirectUri(),
    });
  }

  refresh(refreshToken: string): Promise<GoogleTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** Best effort: revoking the refresh token also invalidates its access tokens. */
  async revoke(token: string): Promise<void> {
    const res = await fetch(this.config.gmail.revokeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 400) throw new Error(`Google revocation failed (${res.status})`);
  }

  async userinfo(
    accessToken: string,
  ): Promise<{ sub: string; email: string; emailVerified: boolean }> {
    const body = await this.call<Record<string, unknown>>(
      accessToken,
      'GET',
      this.config.gmail.userinfoUrl,
    );
    if (typeof body.sub !== 'string' || typeof body.email !== 'string') {
      throw new PermanentError(
        ErrorCategory.PERMANENT_PROVIDER_ERROR,
        'Google returned no account id or email',
      );
    }
    return {
      sub: body.sub,
      email: body.email.toLowerCase(),
      emailVerified: body.email_verified === true,
    };
  }

  // ── Gmail API (users/me) ────────────────────────────────────────────────────

  profile(token: string) {
    return this.gmail<{ emailAddress?: string; historyId?: string }>(token, 'GET', '/profile');
  }

  /** users.watch: returns the history id to start from and the expiry (ms epoch). */
  async watch(
    token: string,
    topicName: string,
    labelIds: string[],
  ): Promise<{ historyId: string; expiration: Date }> {
    const body = await this.gmail<{ historyId?: string; expiration?: string }>(
      token,
      'POST',
      '/watch',
      {
        topicName,
        labelIds,
        labelFilterBehavior: 'INCLUDE',
      },
      // Idempotent (re-watching just renews): failures are retryable.
      false,
    );
    const expiration = Number(body.expiration);
    return {
      historyId: String(body.historyId ?? ''),
      expiration: new Date(Number.isFinite(expiration) ? expiration : Date.now() + 7 * 86_400_000),
    };
  }

  async stop(token: string): Promise<void> {
    await this.gmail(token, 'POST', '/stop', {}, false);
  }

  async history(
    token: string,
    startHistoryId: string,
    pageToken?: string,
  ): Promise<GmailHistoryPage> {
    const query = new URLSearchParams({ startHistoryId, maxResults: '500' });
    query.append('historyTypes', 'messageAdded');
    query.append('historyTypes', 'labelAdded');
    if (pageToken) query.set('pageToken', pageToken);
    try {
      const body = await this.gmail<Partial<GmailHistoryPage>>(token, 'GET', `/history?${query}`);
      return {
        history: body.history ?? [],
        historyId: body.historyId,
        nextPageToken: body.nextPageToken,
      };
    } catch (err) {
      if (err instanceof PermanentError && err.message.startsWith('Gmail: not found'))
        throw new GmailHistoryGoneError();
      throw err;
    }
  }

  message(
    token: string,
    id: string,
    format: 'full' | 'metadata' = 'full',
  ): Promise<GmailMessageResource> {
    return this.gmail<GmailMessageResource>(
      token,
      'GET',
      `/messages/${encodeURIComponent(id)}?format=${format}`,
    );
  }

  send(
    token: string,
    raw: string,
    threadId?: string,
  ): Promise<{ id: string; threadId: string; labelIds?: string[] }> {
    return this.gmail(
      token,
      'POST',
      '/messages/send',
      { raw, ...(threadId && { threadId }) },
      true,
    );
  }

  modify(
    token: string,
    id: string,
    add: string[],
    remove: string[],
  ): Promise<{ id: string; labelIds?: string[] }> {
    return this.gmail(
      token,
      'POST',
      `/messages/${encodeURIComponent(id)}/modify`,
      { addLabelIds: add, removeLabelIds: remove },
      // Idempotent: labels and read state end up the same when applied twice.
      false,
    );
  }

  labels(token: string): Promise<{ labels?: { id?: string; name?: string; type?: string }[] }> {
    return this.gmail(token, 'GET', '/labels');
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private gmail<T>(
    token: string,
    method: string,
    path: string,
    json?: unknown,
    write = false,
  ): Promise<T> {
    return this.call<T>(token, method, `${this.config.gmail.apiUrl}/users/me${path}`, json, write);
  }

  private async token(params: Record<string, string>): Promise<GoogleTokens> {
    let res: Response;
    try {
      res = await fetch(this.config.gmail.tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          ...params,
          client_id: this.config.gmail.clientId!,
          client_secret: this.config.gmail.clientSecret!,
        }).toString(),
        signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS),
      });
    } catch (err) {
      throw providerNetworkError(err, { provider: 'Google sign-in', sideEffect: false });
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.access_token !== 'string') throw mapTokenError(res.status, body);
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
    token: string,
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
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(json !== undefined && { 'content-type': 'application/json' }),
        },
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS),
      });
    } catch (err) {
      throw providerNetworkError(err, { provider: 'Gmail', sideEffect: write });
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw mapGmailError(res.status, res.headers, body, write);
    }
    const text = await res.text().catch(() => '');
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new PermanentError(
        ErrorCategory.PERMANENT_PROVIDER_ERROR,
        'Gmail returned an unreadable response',
      );
    }
  }
}

const safeCode = (code: unknown) =>
  typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : 'unknown_error';

const retryAfterMs = (headers: Headers) => {
  const seconds = Number(headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1_000, 3_600_000) : undefined;
};

export function mapTokenError(status: number, body: Record<string, unknown>): ExecutionError {
  const code = safeCode(body.error);
  if (code === 'invalid_grant')
    return new GmailConsentError(
      'Google no longer accepts this connection (invalid_grant); reconnect Gmail',
    );
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    return new GmailAppCredentialsError(
      `Google rejected FlowForge's OAuth client (${code}); check the client secret`,
    );
  }
  if (status === 429 || status >= 500) {
    return new RetryableError(
      ErrorCategory.TRANSIENT_INFRASTRUCTURE,
      `Google sign-in unavailable (${status})`,
    );
  }
  return new PermanentError(
    ErrorCategory.PERMANENT_PROVIDER_ERROR,
    `Google sign-in failed (${code})`,
  );
}

/** Google API error reasons (error.errors[0].reason, or error.status). */
function reasonOf(body: Record<string, unknown>): string {
  const error = (body.error ?? {}) as { errors?: { reason?: unknown }[]; status?: unknown };
  return safeCode(error.errors?.[0]?.reason ?? error.status);
}

/**
 * Gmail errors (Part 26 error table): 401 → one forced refresh; 403 insufficientPermissions →
 * PROVIDER_AUTH (PERMISSION_CHANGED); 403/429 rate limits → PROVIDER_RATE_LIMIT with backoff;
 * 404 → not found; 5xx → retry for reads/labels, UNCERTAIN_OUTCOME for sends.
 */
export function mapGmailError(
  status: number,
  headers: Headers,
  body: Record<string, unknown>,
  write: boolean,
): ExecutionError {
  const reason = reasonOf(body);
  if (status === 401) return new GmailUnauthorizedError('Gmail rejected the access token');
  if (
    status === 429 ||
    (status === 403 &&
      /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|RESOURCE_EXHAUSTED/i.test(reason))
  ) {
    return new RetryableError(
      ErrorCategory.PROVIDER_RATE_LIMIT,
      `Gmail rate limit reached (${reason})`,
      retryAfterMs(headers) ?? 30_000,
    );
  }
  if (status === 403) {
    return new PermanentError(
      ErrorCategory.PROVIDER_AUTH,
      `Gmail denied access (${reason}); reconnect Gmail and grant the requested permissions`,
    );
  }
  if (status === 404)
    return new PermanentError(
      ErrorCategory.PERMANENT_PROVIDER_ERROR,
      `Gmail: not found (${reason})`,
    );
  if (status === 400)
    return new PermanentError(ErrorCategory.VALIDATION, `Gmail rejected the request (${reason})`);
  if (status >= 500) {
    return write && status !== 503
      ? new PermanentError(
          ErrorCategory.UNCERTAIN_OUTCOME,
          `Gmail returned ${status} after the request was sent; it may have been applied`,
        )
      : new RetryableError(
          ErrorCategory.TRANSIENT_INFRASTRUCTURE,
          `Gmail returned ${status}`,
          retryAfterMs(headers),
        );
  }
  return new PermanentError(
    ErrorCategory.PERMANENT_PROVIDER_ERROR,
    `Gmail rejected the request (${status}, ${reason})`,
  );
}
