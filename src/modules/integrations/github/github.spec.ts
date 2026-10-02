import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { AppConfigService } from '../../../config/app-config.service';
import { GitHubClient, mapGitHubError } from './github-client';
import { issuesOpenedPayload } from '../../../../test/support/github-fixtures';
import { GitHubWebhookProvider } from './github-webhook.provider';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const config = (values: Record<string, string | undefined>) =>
  ({ get: (k: string) => values[k] }) as unknown as AppConfigService;

describe('mapGitHubError', () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  it.each([
    [429, {}, 'PROVIDER_RATE_LIMIT', true],
    [403, { 'x-ratelimit-remaining': '0' }, 'PROVIDER_RATE_LIMIT', true],
    [403, { 'retry-after': '30' }, 'PROVIDER_RATE_LIMIT', true],
    [403, {}, 'PROVIDER_AUTH', false],
    [401, {}, 'PROVIDER_AUTH', false],
    [404, {}, 'PERMANENT_PROVIDER_ERROR', false],
    [422, {}, 'PERMANENT_PROVIDER_ERROR', false],
    [502, {}, 'TRANSIENT_INFRASTRUCTURE', true],
  ])('%d %j → %s (retryable %s)', (status, h, category, retryable) => {
    const err = mapGitHubError(status, headers(h));
    expect(err).toMatchObject({ category, retryable });
  });

  it('uses Retry-After, then x-ratelimit-reset, for the retry delay', () => {
    expect(mapGitHubError(429, headers({ 'retry-after': '30' })).retryAfterMs).toBe(30_000);
    const reset = Math.floor(Date.now() / 1000) + 120;
    const wait = mapGitHubError(
      403,
      headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }),
    ).retryAfterMs!;
    expect(wait).toBeGreaterThan(100_000);
    expect(wait).toBeLessThanOrEqual(120_000);
  });
});

describe('GitHubClient', () => {
  it('signs an RS256 app JWT that verifies with the public key', () => {
    const client = new GitHubClient(
      config({
        GITHUB_APP_ID: '777',
        GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
      }),
    );
    const now = 1_800_000_000;
    const [h, p, sig] = client.appJwt(now).split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({
      iat: now - 60,
      exp: now + 540,
      iss: '777',
    });
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, sig, 'base64url')).toBe(
      true,
    );
  });

  it('accepts the PEM itself as well as base64', () => {
    const client = new GitHubClient(
      config({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey }),
    );
    expect(client.appJwt().split('.')).toHaveLength(3);
  });

  it('is configured only when every GitHub App setting is present', () => {
    const all = {
      GITHUB_APP_ID: '1',
      GITHUB_APP_SLUG: 'flowforge-dev',
      GITHUB_APP_PRIVATE_KEY: 'k',
      GITHUB_CLIENT_ID: 'c',
      GITHUB_CLIENT_SECRET: 's',
      GITHUB_WEBHOOK_SECRET: 'w',
    };
    expect(new GitHubClient(config(all)).isConfigured()).toBe(true);
    expect(
      new GitHubClient(config({ ...all, GITHUB_APP_PRIVATE_KEY: undefined })).isConfigured(),
    ).toBe(false);
  });
});

describe('GitHubWebhookProvider', () => {
  const SECRET = 'github-webhook-secret-for-tests';
  const provider = new GitHubWebhookProvider(config({ GITHUB_WEBHOOK_SECRET: SECRET }));

  const request = (event: string, body: object, secret = SECRET) => {
    const raw = Buffer.from(JSON.stringify(body));
    return {
      rawBody: raw,
      body,
      headers: {
        'x-github-event': event,
        'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
      },
    };
  };

  it('verifies X-Hub-Signature-256 over the raw body', () => {
    expect(provider.verify(request('issues', issuesOpenedPayload()))).toEqual({ ok: true });
    expect(provider.verify(request('issues', issuesOpenedPayload(), 'wrong-secret'))).toMatchObject(
      { ok: false },
    );
    const tampered = request('issues', issuesOpenedPayload());
    tampered.rawBody = Buffer.from(tampered.rawBody.toString().replace('Login', 'Logout'));
    expect(provider.verify(tampered)).toMatchObject({ ok: false });
  });

  it('normalises issues.opened, bound to the installation, with a case-insensitive repo key', () => {
    const req = request('issues', issuesOpenedPayload());
    expect(provider.deliveryId(req)).toBe('72d3162e-cc78-11e3-81ab-4c9367dc0958');
    expect(provider.eventName(req)).toBe('issues.opened');
    expect(provider.normalize(req)).toEqual({
      eventType: 'issues.opened',
      resourceKey: 'octo-org/hello-world',
      accountId: '123',
      data: {
        issue: {
          number: 42,
          title: 'Login page crashes',
          body: 'Steps to reproduce…',
          url: 'https://github.com/Octo-Org/Hello-World/issues/42',
          state: 'open',
          createdAt: '2026-10-01T10:00:00Z',
          labels: ['bug', 'production'],
          author: { login: 'octocat', type: 'User' },
        },
        repository: { fullName: 'Octo-Org/Hello-World', private: false },
        sender: { login: 'octocat', type: 'User' },
      },
    });
  });

  it('ignores other issue actions and events', () => {
    expect(
      provider.normalize(request('issues', { ...issuesOpenedPayload(), action: 'edited' })),
    ).toBeNull();
    expect(provider.normalize(request('push', { installation: { id: 1 } }))).toBeNull();
    expect(provider.normalize(request('issues', { action: 'opened' }))).toBeNull(); // no installation
  });

  it.each([
    ['deleted', 'DISCONNECTED'],
    ['suspend', 'NEEDS_ATTENTION'],
    ['unsuspend', 'CONNECTED'],
  ])('installation.%s → connection %s', (action, status) => {
    expect(
      provider.normalize(request('installation', { action, installation: { id: 9 } })),
    ).toMatchObject({
      eventType: `installation.${action}`,
      accountId: '9',
      connectionStatus: status,
    });
  });

  it('caps very long issue bodies', () => {
    const payload = issuesOpenedPayload();
    payload.issue.body = 'x'.repeat(50_000);
    const data = provider.normalize(request('issues', payload))!.data as {
      issue: { body: string };
    };
    expect(data.issue.body).toHaveLength(10_000);
  });
});
