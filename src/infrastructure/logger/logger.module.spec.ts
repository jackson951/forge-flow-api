import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { Writable } from 'node:stream';
import { FAKE_SECRETS } from '../../../test/support/fake-secrets';
import { AppConfigService } from '../../config/app-config.service';
import { redactQueryString } from '../../common/utils/redact';
import { buildLoggerOptions } from './logger.module';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const config = {
    get: (key: string) => ({ LOG_LEVEL: 'info', NODE_ENV: 'test' })[key],
  } as unknown as AppConfigService;
  const { level, redact, formatters } = buildLoggerOptions(config);
  return { logger: pino({ level, redact, formatters }, stream), lines };
}

describe('logger redaction', () => {
  it('scrubs token-shaped values and credential fields from every log line', () => {
    const { logger, lines } = capture();
    logger.info(
      {
        provider: 'SLACK',
        detail: `calling chat.postMessage with ${FAKE_SECRETS.slackShort}`,
        accessToken: 'plain-secret',
        nested: { headers: { authorization: `Bearer ${'abcdefghijklmnop'}qrstuvwx` } },
      },
      'Provider call',
    );
    logger.warn({ err: new Error(`GitHub said ${FAKE_SECRETS.github} is bad`) }, 'failed');

    const output = lines.join('\n');
    expect(output).not.toContain(FAKE_SECRETS.slackShort);
    expect(output).not.toContain('plain-secret');
    expect(output).not.toContain('abcdefghijklmnopqrstuvwx');
    expect(output).not.toContain(FAKE_SECRETS.github);
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
    expect(output).toContain('Provider call');
  });

  it('redacts request headers by path', () => {
    const { logger, lines } = capture();
    logger.info(
      { req: { headers: { cookie: 'ff_refresh=abc', 'x-slack-signature': 'v0=deadbeef' } } },
      'request',
    );
    expect(lines.join('')).not.toMatch(/ff_refresh=abc|deadbeef/);
  });
});

describe('request logging', () => {
  it('redacts one-time secrets in OAuth callback query strings', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const config = {
      get: (key: string) => ({ LOG_LEVEL: 'info', NODE_ENV: 'test' })[key],
    } as unknown as AppConfigService;
    const options = buildLoggerOptions(config);
    const middleware = pinoHttp({ ...options, transport: undefined }, stream);
    const server = createServer((req, res) => {
      middleware(req, res);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await fetch(
      `http://127.0.0.1:${port}/api/v1/integrations/github/callback?code=oauth-code-canary&installation_id=42&setup_action=install&state=state-canary`,
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const output = lines.join('\n');
    expect(output).toContain('installation_id=42');
    expect(output).toContain('code=[REDACTED]');
    expect(output).not.toContain('oauth-code-canary');
    expect(output).not.toContain('state-canary');
  });

  it.each([
    ['/x?code=abc&state=def&page=2', '/x?code=[REDACTED]&state=[REDACTED]&page=2'],
    ['/x?access_token=abc', '/x?access_token=[REDACTED]'],
    ['/x?installation_id=5', '/x?installation_id=5'],
    ['/x', '/x'],
  ])('redactQueryString(%p)', (input, expected) => {
    expect(redactQueryString(input)).toBe(expected);
  });
});
