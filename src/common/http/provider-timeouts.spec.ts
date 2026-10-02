import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { AppConfigService } from '../../config/app-config.service';
import { validateEnv } from '../../config/env.schema';
import { AnthropicProvider } from '../../modules/ai/anthropic.provider';
import { GITHUB_TIMEOUT_MS, GitHubClient } from '../../modules/integrations/github/github-client';
import {
  MICROSOFT_TIMEOUT_MS,
  MicrosoftClient,
} from '../../modules/integrations/microsoft/microsoft-client';
import { SLACK_TIMEOUT_MS, SlackClient } from '../../modules/integrations/slack/slack-client';

/** Part 18, FR-18.6 / AC-18.6: every outbound provider call has a timeout of at most 30 s. */
const MAX_TIMEOUT_MS = 30_000;

const config = {
  get: (key: string) =>
    ({
      GITHUB_API_URL: 'https://api.github.test',
      GITHUB_WEB_URL: 'https://github.test',
      SLACK_API_URL: 'https://slack.test/api',
      MICROSOFT_LOGIN_URL: 'https://login.test',
      MICROSOFT_GRAPH_URL: 'https://graph.test/v1.0',
      MICROSOFT_TENANT_ID: 'common',
      MICROSOFT_CLIENT_ID: 'id',
      MICROSOFT_CLIENT_SECRET: 'secret',
      OAUTH_REDIRECT_BASE_URL: 'https://api.test/api/v1/integrations',
    })[key],
} as unknown as AppConfigService;

/** Records the timeout behind every signal handed to fetch. */
function capture() {
  const timeouts = new Map<AbortSignal, number>();
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const signal = realTimeout(ms);
    timeouts.set(signal, ms);
    return signal;
  });
  const calls: { url: string; timeoutMs: number | undefined }[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({
      url: String(url),
      timeoutMs: init?.signal ? timeouts.get(init.signal) : undefined,
    });
    return Response.json({ ok: true, ts: '1.2', installations: [], value: [], id: 'x' });
  });
  return { calls, timeouts };
}

afterEach(() => jest.restoreAllMocks());

describe('provider timeouts (AC-18.6)', () => {
  it('declared client timeouts are at most 30 s', () => {
    for (const ms of [GITHUB_TIMEOUT_MS, SLACK_TIMEOUT_MS, MICROSOFT_TIMEOUT_MS]) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
    }
  });

  it('GitHub calls carry a timeout signal', async () => {
    const { calls } = capture();
    await new GitHubClient(config).userInstallationIds('user-token');
    expect(calls).toEqual([expect.objectContaining({ timeoutMs: GITHUB_TIMEOUT_MS })]);
  });

  it('Slack calls carry a timeout signal', async () => {
    const { calls } = capture();
    await new SlackClient(config).postMessage('token', 'C1', 'hi');
    expect(calls).toEqual([expect.objectContaining({ timeoutMs: SLACK_TIMEOUT_MS })]);
  });

  it('Microsoft Graph calls carry a timeout signal', async () => {
    const { calls } = capture();
    await new MicrosoftClient(config).todoLists('token');
    expect(calls).toEqual([expect.objectContaining({ timeoutMs: MICROSOFT_TIMEOUT_MS })]);
  });

  it('the AI provider uses AI_TIMEOUT_MS, which cannot exceed 30 s', async () => {
    const { calls, timeouts } = capture();
    await new AnthropicProvider({
      apiKey: 'k',
      apiUrl: 'https://ai.test',
      model: 'm',
      timeoutMs: 20_000,
    })
      .complete({
        system: 's',
        prompt: 'p',
        jsonSchema: {},
        maxOutputTokens: 10,
        signal: new AbortController().signal,
      })
      .catch(() => undefined);
    expect(calls).toHaveLength(1);
    expect([...timeouts.values()]).toContain(20_000);

    const base = {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      JWT_REFRESH_SECRET: 'b'.repeat(32),
    };
    expect(() => validateEnv({ ...base, AI_TIMEOUT_MS: '30001' })).toThrow(/AI_TIMEOUT_MS/);
  });

  it('every source file that calls fetch() also sets a timeout', () => {
    const root = join(__dirname, '..', '..');
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return walk(path);
        return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
      });
    })(root);
    const offenders = files
      .filter((path) => /\bfetch(Impl)?\(/.test(readFileSync(path, 'utf8')))
      .filter((path) => !readFileSync(path, 'utf8').includes('AbortSignal.timeout('))
      .map((path) => relative(root, path).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });
});
