import { ErrorCategory } from '@prisma/client';
import { AppConfigService } from '../../../config/app-config.service';
import { PermanentError, RetryableError } from '../../../engine/errors';
import { NodeExecutionContext } from '../../../engine/execution/node-handler';
import { runRetryDelay } from '../../../infrastructure/queue/retry-backoff';
import { FAKE_SECRETS } from '../../../../test/support/fake-secrets';
import { mapSlackApiError, mapSlackHttpError, SlackClient } from './slack-client';
import { createSlackHandlers, escapeBroadcastMentions, SLACK_MAX_TEXT } from './slack.node-types';

const TOKEN = FAKE_SECRETS.slackAccess;
const config = {
  get: (key: string) =>
    ({
      SLACK_CLIENT_ID: '123.456',
      SLACK_CLIENT_SECRET: 'slack-client-secret',
      OAUTH_REDIRECT_BASE_URL: 'https://api.example.test/api/v1/integrations/',
      SLACK_OAUTH_URL: 'https://slack.example.test/oauth/v2/authorize',
      SLACK_API_URL: 'http://127.0.0.1:1/api',
    })[key],
} as unknown as AppConfigService;

/** Replaces global fetch for one test; requests are recorded. */
function mockFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: String(url), init: init! });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  return { calls, spy };
}
const ok = (body: object, headers: Record<string, string> = {}) =>
  Response.json({ ok: true, ...body }, { headers });
const slackError = (error: string, headers: Record<string, string> = {}) =>
  Response.json({ ok: false, error }, { headers });

afterEach(() => jest.restoreAllMocks());

describe('SlackClient', () => {
  const client = new SlackClient(config);

  it('builds the authorize URL with bot scopes, redirect URI and state', () => {
    const url = new URL(client.authorizeUrl('st4te'));
    expect(url.origin + url.pathname).toBe('https://slack.example.test/oauth/v2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: '123.456',
      scope: 'chat:write,channels:read,groups:read',
      redirect_uri: 'https://api.example.test/api/v1/integrations/slack/callback',
      state: 'st4te',
    });
  });

  it('exchanges the code with client credentials (form-encoded) and maps team metadata', async () => {
    const { calls } = mockFetch(
      ok({
        access_token: TOKEN,
        token_type: 'bot',
        scope: 'chat:write,channels:read',
        bot_user_id: 'U0BOT',
        team: { id: 'T123', name: 'Acme' },
      }),
    );
    expect(await client.exchangeCode('the-code')).toEqual({
      accessToken: TOKEN,
      teamId: 'T123',
      teamName: 'Acme',
      botUserId: 'U0BOT',
      scopes: ['chat:write', 'channels:read'],
    });
    expect(calls[0].url).toBe('http://127.0.0.1:1/api/oauth.v2.access');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('123.456:slack-client-secret').toString('base64')}`,
    );
    expect(Object.fromEntries(calls[0].init.body as URLSearchParams)).toEqual({
      code: 'the-code',
      redirect_uri: 'https://api.example.test/api/v1/integrations/slack/callback',
    });
  });

  it('refuses enterprise-wide installs and non-bot tokens', async () => {
    mockFetch(ok({ access_token: TOKEN, token_type: 'bot', team: null, enterprise: { id: 'E1' } }));
    await expect(client.exchangeCode('c')).rejects.toBeInstanceOf(PermanentError);
  });

  it('posts a message with parse=none and returns ts', async () => {
    const { calls } = mockFetch(ok({ ts: '1700000000.000100', channel: 'C1' }));
    expect(await client.postMessage(TOKEN, 'C1', 'hello')).toBe('1700000000.000100');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.fromEntries(calls[0].init.body as URLSearchParams)).toEqual({
      channel: 'C1',
      text: 'hello',
      parse: 'none',
      link_names: 'false',
      unfurl_links: 'false',
    });
  });

  it('lists channels as ids and names with the next cursor', async () => {
    mockFetch(
      ok({
        channels: [
          { id: 'C1', name: 'general', is_private: false, topic: { value: 'secret plans' } },
          { id: 'G2', name: 'ops', is_private: true },
        ],
        response_metadata: { next_cursor: 'dXNlcjpVMDYxTkZUVDI=' },
      }),
    );
    expect(await client.listChannels(TOKEN)).toEqual({
      channels: [
        { id: 'C1', name: 'general', isPrivate: false },
        { id: 'G2', name: 'ops', isPrivate: true },
      ],
      nextCursor: 'dXNlcjpVMDYxTkZUVDI=',
    });
  });

  describe('error classification (AC-13.3, AC-13.5)', () => {
    it.each([
      ['invalid_auth', PermanentError, ErrorCategory.PROVIDER_AUTH],
      ['token_revoked', PermanentError, ErrorCategory.PROVIDER_AUTH],
      ['account_inactive', PermanentError, ErrorCategory.PROVIDER_AUTH],
      ['not_in_channel', PermanentError, ErrorCategory.PERMANENT_PROVIDER_ERROR],
      ['channel_not_found', PermanentError, ErrorCategory.PERMANENT_PROVIDER_ERROR],
      ['ratelimited', RetryableError, ErrorCategory.PROVIDER_RATE_LIMIT],
      ['internal_error', RetryableError, ErrorCategory.TRANSIENT_INFRASTRUCTURE],
      ['something_new', PermanentError, ErrorCategory.PERMANENT_PROVIDER_ERROR],
    ])('%s → %p %s', (code, type, category) => {
      const err = mapSlackApiError(code, new Headers());
      expect(err).toBeInstanceOf(type);
      expect(err.category).toBe(category);
    });

    it('gives actionable messages for channel problems', () => {
      expect(mapSlackApiError('not_in_channel', new Headers()).message).toMatch(/\/invite/);
      expect(mapSlackApiError('channel_not_found', new Headers()).message).toMatch(
        /channel not found/,
      );
    });

    it('never echoes unexpected error strings', () => {
      expect(mapSlackApiError(`bad ${TOKEN}`, new Headers()).message).toBe(
        'Slack error: unknown_error',
      );
    });

    it('HTTP 429 honours Retry-After, and the worker waits that long', async () => {
      mockFetch(new Response('', { status: 429, headers: { 'retry-after': '7' } }));
      const err = await client.postMessage(TOKEN, 'C1', 'x').catch((e) => e);
      expect(err).toBeInstanceOf(RetryableError);
      expect(err).toMatchObject({
        category: ErrorCategory.PROVIDER_RATE_LIMIT,
        retryAfterMs: 7000,
      });
      expect(runRetryDelay(1, 50, err)).toBe(7000);
      expect(mapSlackHttpError(429, new Headers()).retryAfterMs).toBe(30_000);
    });

    it('5xx and requests that never left (connection refused, DNS) are retryable', async () => {
      const refused = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      const dns = new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
      mockFetch(new Response('', { status: 503 }), refused, dns);
      for (let i = 0; i < 3; i++) {
        const err = await client.postMessage(TOKEN, 'C1', 'x').catch((e) => e);
        expect(err).toBeInstanceOf(RetryableError);
        expect(err.category).toBe(ErrorCategory.TRANSIENT_INFRASTRUCTURE);
      }
    });

    it('a connection lost mid-request is uncertain when posting, retryable when reading (S4)', async () => {
      const reset = () => new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      mockFetch(reset(), reset());
      const post = await client.postMessage(TOKEN, 'C1', 'x').catch((e) => e);
      expect(post).toBeInstanceOf(PermanentError);
      expect(post.category).toBe(ErrorCategory.UNCERTAIN_OUTCOME);
      const list = await client.listChannels(TOKEN).catch((e) => e);
      expect(list).toBeInstanceOf(RetryableError);
    });

    it('a timeout while posting is UNCERTAIN_OUTCOME (not retried); while reading, retryable', async () => {
      const timeout = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      mockFetch(timeout(), timeout());
      const post = await client.postMessage(TOKEN, 'C1', 'x').catch((e) => e);
      expect(post).toBeInstanceOf(PermanentError);
      expect(post.category).toBe(ErrorCategory.UNCERTAIN_OUTCOME);
      const list = await client.listChannels(TOKEN).catch((e) => e);
      expect(list).toBeInstanceOf(RetryableError);
      expect(list.category).toBe(ErrorCategory.PROVIDER_TIMEOUT);
    });

    it('error messages never contain the token', async () => {
      mockFetch(slackError('token_revoked'));
      const err = await client.postMessage(TOKEN, 'C1', 'x').catch((e) => e);
      expect(err.message).not.toContain(TOKEN);
    });
  });
});

describe('retry delay', () => {
  it('uses exponential backoff with jitter when no Retry-After is given', () => {
    expect(runRetryDelay(1, 1000, new Error('x'), () => 0)).toBe(700);
    expect(runRetryDelay(3, 1000, new Error('x'), () => 1)).toBe(4000);
    expect(runRetryDelay(30, 1000, undefined, () => 1)).toBe(15 * 60_000);
  });
});

describe('escapeBroadcastMentions', () => {
  it.each([
    ['<!channel> deploy now', '&lt;!channel&gt; deploy now'],
    ['hey <!here|here>', 'hey &lt;!here|here&gt;'],
    ['<!EVERYONE>', '&lt;!EVERYONE&gt;'],
    ['ping <!subteam^S123|@oncall>', 'ping &lt;!subteam^S123|@oncall&gt;'],
    ['<@U123> and <https://x.test|link>', '<@U123> and <https://x.test|link>'],
  ])('%p', (input, expected) => {
    expect(escapeBroadcastMentions(input)).toBe(expected);
  });
});

describe('slack.sendMessage handler', () => {
  const connections = {
    accessToken: jest.fn(async () => TOKEN),
    markNeedsAttention: jest.fn(async () => undefined),
  };
  const slack = { postMessage: jest.fn() } as unknown as jest.Mocked<SlackClient>;
  const [handler] = createSlackHandlers(slack, connections);
  const context = (config: Record<string, unknown>): NodeExecutionContext => ({
    runId: 'r',
    workspaceId: 'ws-1',
    nodeKey: 'notify',
    config: { connectionId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', channelId: 'C123', ...config },
    triggerInput: {},
    outputs: {},
    idempotencyKey: 'r:notify',
    attempt: 1,
    signal: new AbortController().signal,
    logger: { info: jest.fn(), warn: jest.fn() },
  });

  beforeEach(() => jest.clearAllMocks());

  it('is non-idempotent and records the message ts as externalRef', async () => {
    slack.postMessage.mockResolvedValue('171.000200');
    const result = await handler.execute(context({ text: 'Issue #5: <!channel> help' }));

    expect(handler.sideEffect).toBe('non-idempotent');
    expect(result).toEqual({
      output: { channelId: 'C123', ts: '171.000200' },
      externalRef: '171.000200',
    });
    expect(connections.accessToken).toHaveBeenCalledWith(
      'ws-1',
      '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      'SLACK',
    );
    expect(slack.postMessage).toHaveBeenCalledWith(
      TOKEN,
      'C123',
      'Issue #5: &lt;!channel&gt; help',
    );
  });

  it('keeps broadcast mentions when explicitly allowed', async () => {
    slack.postMessage.mockResolvedValue('1.2');
    await handler.execute(context({ text: '<!here> deploy', allowBroadcastMentions: true }));
    expect(slack.postMessage).toHaveBeenCalledWith(TOKEN, 'C123', '<!here> deploy');
  });

  it('truncates rendered text above 3 000 characters', async () => {
    slack.postMessage.mockResolvedValue('1.2');
    const result = await handler.execute(context({ text: 'x'.repeat(5000) }));
    const sent = slack.postMessage.mock.calls[0][2];
    expect(sent).toHaveLength(SLACK_MAX_TEXT);
    expect(sent.endsWith('…')).toBe(true);
    expect(result.output).toMatchObject({ truncated: true });
  });

  it('marks the connection NEEDS_ATTENTION on a revoked token (AC-13.4)', async () => {
    slack.postMessage.mockRejectedValue(mapSlackApiError('token_revoked', new Headers()));
    await expect(handler.execute(context({ text: 'hi' }))).rejects.toMatchObject({
      category: ErrorCategory.PROVIDER_AUTH,
    });
    expect(connections.markNeedsAttention).toHaveBeenCalledWith(
      'ws-1',
      '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    );
  });

  it('does not touch the connection for channel errors', async () => {
    slack.postMessage.mockRejectedValue(mapSlackApiError('not_in_channel', new Headers()));
    await expect(handler.execute(context({ text: 'hi' }))).rejects.toMatchObject({
      category: ErrorCategory.PERMANENT_PROVIDER_ERROR,
    });
    expect(connections.markNeedsAttention).not.toHaveBeenCalled();
  });

  it('logs no message content or token', async () => {
    slack.postMessage.mockResolvedValue('1.2');
    const ctx = context({ text: 'confidential incident details' });
    await handler.execute(ctx);
    const logged = JSON.stringify((ctx.logger.info as jest.Mock).mock.calls);
    expect(logged).not.toContain('confidential');
    expect(logged).not.toContain(TOKEN);
  });
});
