import { Injectable } from '@nestjs/common';
import { ErrorCategory } from '@prisma/client';
import { providerNetworkError } from '../../../common/http/fetch-failure';
import { AppConfigService } from '../../../config/app-config.service';
import { ExecutionError, PermanentError, RetryableError } from '../../../engine/errors';

const TIMEOUT_MS = 10_000;

/** Bot scopes requested on connect. No user-token scopes. */
export const SLACK_BOT_SCOPES = ['chat:write', 'channels:read', 'groups:read'];

export interface SlackOAuthResult {
  accessToken: string;
  teamId: string;
  teamName: string;
  botUserId: string | null;
  scopes: string[];
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/** Slack Web API errors meaning the token no longer works: the user must reconnect. */
const AUTH_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'no_permission',
  'missing_scope',
  'org_login_required',
  'ekm_access_denied',
]);

/** Errors the workflow author can fix; the message says how. */
const ACTIONABLE_ERRORS: Record<string, string> = {
  not_in_channel: 'The FlowForge Slack app is not in this channel; invite it with /invite',
  channel_not_found: 'Slack channel not found, or it is private and the app is not in it',
  is_archived: 'The Slack channel is archived',
  msg_too_long: 'The Slack message is too long',
  no_text: 'The Slack message is empty',
  restricted_action: 'Posting to this Slack channel is restricted by the workspace',
};

/** Slack-side failures worth retrying. */
const TRANSIENT_ERRORS = new Set([
  'internal_error',
  'fatal_error',
  'service_unavailable',
  'request_timeout',
]);

/**
 * Minimal Slack Web API client (no SDK, so Slack-side retries never duplicate messages:
 * FlowForge owns the retry policy). Every call has a 10 s timeout; failures map to execution
 * error categories. Tokens are passed per call and never logged or included in errors.
 */
@Injectable()
export class SlackClient {
  constructor(private readonly config: AppConfigService) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.get('SLACK_CLIENT_ID') &&
      this.config.get('SLACK_CLIENT_SECRET') &&
      this.config.get('OAUTH_REDIRECT_BASE_URL'),
    );
  }

  redirectUri(): string {
    return `${this.config.get('OAUTH_REDIRECT_BASE_URL')!.replace(/\/$/, '')}/slack/callback`;
  }

  authorizeUrl(state: string): string {
    const url = new URL(this.config.get('SLACK_OAUTH_URL'));
    url.searchParams.set('client_id', this.config.get('SLACK_CLIENT_ID')!);
    url.searchParams.set('scope', SLACK_BOT_SCOPES.join(','));
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** `oauth.v2.access`: exchanges the callback code for a bot token. */
  async exchangeCode(code: string): Promise<SlackOAuthResult> {
    const credentials = Buffer.from(
      `${this.config.get('SLACK_CLIENT_ID')}:${this.config.get('SLACK_CLIENT_SECRET')}`,
    ).toString('base64');
    const body = await this.call(
      'oauth.v2.access',
      { code, redirect_uri: this.redirectUri() },
      { authorization: `Basic ${credentials}` },
    );
    const team = body.team as { id?: string; name?: string } | null | undefined;
    if (body.token_type !== 'bot' || typeof body.access_token !== 'string' || !team?.id) {
      // Enterprise-wide installs (no team) and user tokens are not supported.
      throw new PermanentError(
        ErrorCategory.PERMANENT_PROVIDER_ERROR,
        'Slack returned an unsupported installation (expected a workspace bot token)',
      );
    }
    return {
      accessToken: body.access_token,
      teamId: team.id,
      teamName: team.name ?? team.id,
      botUserId: typeof body.bot_user_id === 'string' ? body.bot_user_id : null,
      scopes: String(body.scope ?? '')
        .split(',')
        .filter(Boolean),
    };
  }

  /** `chat.postMessage`. Returns the message `ts`. Not idempotent: never retried here. */
  async postMessage(token: string, channel: string, text: string): Promise<string> {
    const body = await this.call(
      'chat.postMessage',
      // parse: none + link_names: false — text is posted as written (mentions stay escaped).
      { channel, text, parse: 'none', link_names: false, unfurl_links: false },
      { authorization: `Bearer ${token}` },
      { sideEffect: true },
    );
    if (typeof body.ts !== 'string') {
      throw new PermanentError(
        ErrorCategory.UNCERTAIN_OUTCOME,
        'Slack accepted the message but returned no timestamp',
      );
    }
    return body.ts;
  }

  /** `conversations.list`: public channels and private ones the bot is in, one page. */
  async listChannels(
    token: string,
    cursor?: string,
    limit = 100,
  ): Promise<{ channels: SlackChannel[]; nextCursor: string | null }> {
    const body = await this.call(
      'conversations.list',
      {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit,
        ...(cursor && { cursor }),
      },
      { authorization: `Bearer ${token}` },
    );
    const channels = (body.channels as { id: string; name: string; is_private?: boolean }[]) ?? [];
    const next = (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
    return {
      channels: channels.map((c) => ({ id: c.id, name: c.name, isPrivate: Boolean(c.is_private) })),
      nextCursor: next || null,
    };
  }

  /** `auth.revoke`: invalidates the bot token (used on disconnect). */
  async revoke(token: string): Promise<void> {
    await this.call('auth.revoke', {}, { authorization: `Bearer ${token}` });
  }

  private async call(
    method: string,
    params: Record<string, unknown>,
    headers: Record<string, string>,
    { sideEffect = false } = {},
  ): Promise<SlackResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.config.get('SLACK_API_URL')}/${method}`, {
        method: 'POST',
        // Form encoding: accepted by every Web API method (oauth.v2.access and read methods
        // do not accept JSON bodies).
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(
          Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string]),
        ),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw networkError(err, sideEffect);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw mapSlackHttpError(res.status, res.headers);
    }
    let body: SlackResponse;
    try {
      body = (await res.json()) as SlackResponse;
    } catch (err) {
      throw networkError(err, sideEffect);
    }
    if (!body.ok) throw mapSlackApiError(body.error, res.headers);
    return body;
  }
}

/**
 * A request that never left (DNS, refused) is retried; a timeout or a connection lost
 * mid-request on a side-effecting call is ambiguous — Slack may have posted the message — so
 * it is UNCERTAIN_OUTCOME and not retried automatically (Part 15).
 */
const networkError = (err: unknown, sideEffect: boolean): ExecutionError =>
  providerNetworkError(err, { provider: 'Slack', sideEffect });

const retryAfterMs = (headers: Headers) => {
  const seconds = Number(headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000;
};

/** HTTP status → execution error (Slack answers 429 when rate limited). */
export function mapSlackHttpError(status: number, headers: Headers): ExecutionError {
  if (status === 429) {
    return new RetryableError(
      ErrorCategory.PROVIDER_RATE_LIMIT,
      'Slack rate limit reached',
      retryAfterMs(headers),
    );
  }
  if (status >= 500) {
    return new RetryableError(ErrorCategory.TRANSIENT_INFRASTRUCTURE, `Slack returned ${status}`);
  }
  return new PermanentError(ErrorCategory.PERMANENT_PROVIDER_ERROR, `Slack returned ${status}`);
}

/** `{ ok: false, error }` → execution error. Only the error code is used, never other fields. */
export function mapSlackApiError(error: string | undefined, headers: Headers): ExecutionError {
  const code = /^[a-z0-9_]{1,64}$/.test(error ?? '') ? error! : 'unknown_error';
  if (AUTH_ERRORS.has(code)) {
    return new PermanentError(
      ErrorCategory.PROVIDER_AUTH,
      `Slack rejected the connection (${code}); reconnect Slack`,
    );
  }
  if (code === 'ratelimited') {
    return new RetryableError(
      ErrorCategory.PROVIDER_RATE_LIMIT,
      'Slack rate limit reached',
      retryAfterMs(headers),
    );
  }
  if (TRANSIENT_ERRORS.has(code)) {
    return new RetryableError(ErrorCategory.TRANSIENT_INFRASTRUCTURE, `Slack error: ${code}`);
  }
  return new PermanentError(
    ErrorCategory.PERMANENT_PROVIDER_ERROR,
    ACTIONABLE_ERRORS[code] ? `${ACTIONABLE_ERRORS[code]} (${code})` : `Slack error: ${code}`,
  );
}
