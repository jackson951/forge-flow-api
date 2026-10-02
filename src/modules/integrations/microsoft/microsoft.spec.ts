import { ErrorCategory } from '@prisma/client';
import { AppConfigService } from '../../../config/app-config.service';
import { PermanentError, RetryableError } from '../../../engine/errors';
import { runRetryDelay } from '../../../infrastructure/queue/retry-backoff';
import { MicrosoftProvider } from '../providers/microsoft.provider';
import {
  GraphUnauthorizedError,
  idTokenClaims,
  mapGraphError,
  mapTokenError,
  MicrosoftAppCredentialsError,
  MicrosoftClient,
  MicrosoftConsentError,
  MICROSOFT_SCOPES,
} from './microsoft-client';
import { normaliseDueDate } from './microsoft.node-types';

const GRAPH = 'https://graph.example.test/v1.0';
const config = {
  get: (key: string) =>
    ({
      MICROSOFT_CLIENT_ID: 'client-id',
      MICROSOFT_CLIENT_SECRET: 'entra-secret',
      MICROSOFT_TENANT_ID: 'contoso.onmicrosoft.com',
      MICROSOFT_LOGIN_URL: 'https://login.example.test/',
      MICROSOFT_GRAPH_URL: GRAPH,
      OAUTH_REDIRECT_BASE_URL: 'https://api.example.test/api/v1/integrations',
    })[key],
} as unknown as AppConfigService;
const client = new MicrosoftClient(config);

function mockFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: String(url), init: init! });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  return calls;
}
afterEach(() => jest.restoreAllMocks());

const tokenResponse = (extra: object = {}) =>
  Response.json({
    token_type: 'Bearer',
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    expires_in: 3600,
    scope: 'openid profile offline_access User.Read Tasks.ReadWrite',
    ...extra,
  });

describe('MicrosoftClient', () => {
  it('authorize URL: tenant authority, least-privilege scopes only, PKCE S256 (AC-14.2)', () => {
    const url = new URL(client.authorizeUrl('st', 'challenge123'));
    expect(url.origin + url.pathname).toBe(
      'https://login.example.test/contoso.onmicrosoft.com/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('scope')).toBe(
      'openid profile offline_access User.Read Tasks.ReadWrite',
    );
    expect(url.searchParams.get('scope')).not.toMatch(/Mail|Files|Calendars|\.default/);
    expect(url.searchParams.get('code_challenge')).toBe('challenge123');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.test/api/v1/integrations/microsoft/callback',
    );
    expect(MICROSOFT_SCOPES).toHaveLength(5);
  });

  it('exchanges the code with the verifier and client secret (form-encoded)', async () => {
    const calls = mockFetch(tokenResponse({ id_token: 'x.y.z' }));
    const tokens = await client.exchangeCode('the-code', 'the-verifier');

    expect(calls[0].url).toBe(
      'https://login.example.test/contoso.onmicrosoft.com/oauth2/v2.0/token',
    );
    expect(Object.fromEntries(calls[0].init.body as URLSearchParams)).toEqual({
      client_id: 'client-id',
      client_secret: 'entra-secret',
      scope: MICROSOFT_SCOPES.join(' '),
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://api.example.test/api/v1/integrations/microsoft/callback',
      code_verifier: 'the-verifier',
    });
    expect(tokens).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3500_000);
  });

  it('keeps refresh optional (Microsoft may not rotate it)', async () => {
    mockFetch(tokenResponse({ refresh_token: undefined }));
    expect((await client.refresh('old')).refreshToken).toBeUndefined();
  });

  it('follows next links on Graph only', async () => {
    mockFetch(
      Response.json({
        value: [{ id: 'L1', displayName: 'Tasks', wellknownListName: 'defaultList' }],
        '@odata.nextLink': `${GRAPH}/me/todo/lists?$skiptoken=2`,
      }),
      Response.json({ value: [{ id: 'L2', displayName: 'Work' }] }),
    );
    expect(await client.todoLists('t')).toEqual([
      { id: 'L1', displayName: 'Tasks', isDefault: true },
      { id: 'L2', displayName: 'Work', isDefault: false },
    ]);

    mockFetch(Response.json({ value: [], '@odata.nextLink': 'https://graph.example.test.evil/x' }));
    await expect(client.todoLists('t')).rejects.toThrow('unexpected paging link');
  });

  it('createTask sends title, text body and UTC due date; encodes the list id', async () => {
    const calls = mockFetch(
      Response.json({ id: 'task-1' }, { status: 201, headers: { 'request-id': 'r-1' } }),
    );
    expect(
      await client.createTask('t', 'AAMk/AD==', { title: 'T', body: 'B', dueDate: '2026-12-01' }),
    ).toEqual({ id: 'task-1', requestId: 'r-1' });
    expect(calls[0].url).toBe(`${GRAPH}/me/todo/lists/AAMk%2FAD%3D%3D/tasks`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      title: 'T',
      body: { content: 'B', contentType: 'text' },
      dueDateTime: { dateTime: '2026-12-01T00:00:00', timeZone: 'UTC' },
    });
  });

  it('a timeout while creating a task is UNCERTAIN_OUTCOME; while reading, retryable', async () => {
    const timeout = () => Object.assign(new Error('t'), { name: 'TimeoutError' });
    mockFetch(timeout(), timeout());
    await expect(client.createTask('t', 'L', { title: 'x' })).rejects.toMatchObject({
      category: ErrorCategory.UNCERTAIN_OUTCOME,
      retryable: false,
    });
    await expect(client.todoLists('t')).rejects.toMatchObject({
      category: ErrorCategory.PROVIDER_TIMEOUT,
      retryable: true,
    });
  });

  it('never puts tokens into error messages', async () => {
    mockFetch(Response.json({ error: { code: 'InvalidAuthenticationToken' } }, { status: 401 }));
    const err = await client.todoLists('secret-access-token').catch((e) => e);
    expect(err).toBeInstanceOf(GraphUnauthorizedError);
    expect(err.message).not.toContain('secret-access-token');
  });
});

describe('error classification', () => {
  const h = (headers: Record<string, string> = {}) => new Headers(headers);

  it.each([
    ['invalid_grant', MicrosoftConsentError],
    ['interaction_required', MicrosoftConsentError],
    ['consent_required', MicrosoftConsentError],
    ['invalid_client', MicrosoftAppCredentialsError],
    ['unauthorized_client', MicrosoftAppCredentialsError],
  ])('token error %s (FR-14.6)', (code, type) => {
    const err = mapTokenError(400, h(), { error: code, error_description: 'AADSTS… secret' });
    expect(err).toBeInstanceOf(type);
    expect(err.category).toBe(ErrorCategory.PROVIDER_AUTH);
    expect(err.message).not.toContain('AADSTS');
  });

  it('token endpoint throttling and outages are retryable', () => {
    expect(mapTokenError(429, h({ 'retry-after': '4' }), {})).toMatchObject({
      category: ErrorCategory.PROVIDER_RATE_LIMIT,
      retryAfterMs: 4000,
    });
    expect(mapTokenError(400, h(), { error: 'temporarily_unavailable' })).toBeInstanceOf(
      RetryableError,
    );
    expect(mapTokenError(503, h(), {})).toBeInstanceOf(RetryableError);
  });

  it('Graph 429 and 503 with Retry-After are throttling; the queue waits that long (AC-14.6)', () => {
    const throttled = mapGraphError(429, h({ 'retry-after': '12' }), 'TooManyRequests', 'r-9');
    expect(throttled).toMatchObject({
      category: ErrorCategory.PROVIDER_RATE_LIMIT,
      retryAfterMs: 12_000,
    });
    expect(throttled.message).toContain('request-id r-9');
    expect(runRetryDelay(1, 50, throttled)).toBe(12_000);
    expect(mapGraphError(503, h({ 'retry-after': '3' }), undefined, null)).toMatchObject({
      category: ErrorCategory.PROVIDER_RATE_LIMIT,
      retryAfterMs: 3000,
    });
    expect(mapGraphError(503, h(), undefined, null)).toMatchObject({
      category: ErrorCategory.TRANSIENT_INFRASTRUCTURE,
      retryable: true,
    });
  });

  it.each([
    [401, GraphUnauthorizedError, ErrorCategory.PROVIDER_AUTH],
    [403, PermanentError, ErrorCategory.PROVIDER_AUTH],
    [404, PermanentError, ErrorCategory.PERMANENT_PROVIDER_ERROR],
    [400, PermanentError, ErrorCategory.PERMANENT_PROVIDER_ERROR],
    [500, RetryableError, ErrorCategory.TRANSIENT_INFRASTRUCTURE],
  ])('Graph %d', (status, type, category) => {
    const err = mapGraphError(status, h(), `Code ${'<script>'}`, null);
    expect(err).toBeInstanceOf(type);
    expect(err.category).toBe(category);
    expect(err.message).toContain('unknown_error'); // unexpected codes are not echoed
  });
});

describe('MicrosoftProvider', () => {
  const microsoft = {
    isConfigured: () => true,
    authorizeUrl: jest.fn(() => 'https://login.example.test/authorize'),
    exchangeCode: jest.fn(),
    me: jest.fn(async () => ({
      id: 'user-1',
      displayName: 'Ada',
      userPrincipalName: 'ada@contoso.test',
      mail: null,
    })),
  } as unknown as jest.Mocked<MicrosoftClient>;
  const provider = new MicrosoftProvider(microsoft, { isConfigured: () => true } as never);
  const payload = Buffer.from(JSON.stringify({ tid: 'tenant-1' })).toString('base64url');

  it('requires PKCE', () => {
    expect(provider.usesPkce).toBe(true);
    expect(() => provider.connectUrl('s')).toThrow('PKCE');
  });

  it('identifies the account from Graph, uses the id_token for display only, returns tokens', async () => {
    microsoft.exchangeCode.mockResolvedValue({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(1),
      scopes: ['openid', 'https://graph.microsoft.com/Tasks.ReadWrite', 'offline_access'],
      idToken: `h.${payload}.s`,
    });
    const result = await provider.completeConnection({ code: 'c' }, { codeVerifier: 'v' });
    expect(microsoft.exchangeCode).toHaveBeenCalledWith('c', 'v');
    expect(result).toEqual({
      externalAccountId: 'user-1',
      accountLabel: 'ada@contoso.test',
      scopes: ['openid', 'Tasks.ReadWrite', 'offline_access'],
      metadata: { displayName: 'Ada', userPrincipalName: 'ada@contoso.test', tenantId: 'tenant-1' },
      credential: { accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: new Date(1) },
    });
  });

  it('refuses consent without Tasks.ReadWrite or without a refresh token', async () => {
    microsoft.exchangeCode.mockResolvedValue({
      accessToken: 'a',
      refreshToken: undefined,
      expiresAt: new Date(),
      scopes: ['Tasks.ReadWrite'],
    });
    await expect(
      provider.completeConnection({ code: 'c' }, { codeVerifier: 'v' }),
    ).rejects.toMatchObject({
      reason: 'not_authorized',
    });
    await expect(provider.completeConnection({ code: 'c' }, {})).rejects.toMatchObject({
      reason: 'denied',
    });
  });

  it('id_token claims are best effort', () => {
    expect(idTokenClaims('garbage')).toEqual({});
    expect(idTokenClaims(undefined)).toEqual({});
  });
});

describe('normaliseDueDate', () => {
  it.each([
    ['2026-10-15', '2026-10-15'],
    ['2026-10-15T08:30:00Z', '2026-10-15'],
    ['', undefined],
    [undefined, undefined],
  ])('%p → %p', (input, expected) => {
    expect(normaliseDueDate(input)).toBe(expected);
  });

  it.each(['15/10/2026', '2026-02-30', 'tomorrow', '2026-13-01'])('rejects %p', (input) => {
    expect(() => normaliseDueDate(input)).toThrow('YYYY-MM-DD');
  });
});
