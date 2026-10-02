import pino from 'pino';
import { Writable } from 'node:stream';
import { FAKE_SECRETS } from '../../../test/support/fake-secrets';
import { AppConfigService } from '../../config/app-config.service';
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
