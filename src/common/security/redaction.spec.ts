import { FAKE_SECRETS } from '../../../test/support/fake-secrets';
import { looksLikeSecret, REDACTED, redactSecrets, redactString } from './redaction';

const SAMPLES = {
  slack: FAKE_SECRETS.slack,
  github: FAKE_SECRETS.github,
  githubUser: FAKE_SECRETS.githubUser,
  pat: FAKE_SECRETS.githubPat,
  jwt: FAKE_SECRETS.jwt,
  bearer: FAKE_SECRETS.bearer,
  pem: FAKE_SECRETS.privateKey,
  ai: FAKE_SECRETS.aiKey,
  aws: FAKE_SECRETS.awsKeyId,
};

describe('redaction', () => {
  it.each(Object.entries(SAMPLES))('detects and removes a %s credential', (_kind, secret) => {
    expect(looksLikeSecret(`prefix ${secret} suffix`)).toBe(true);
    const redacted = redactString(`prefix ${secret} suffix`);
    expect(redacted).not.toContain(secret.slice(4, 20));
    expect(redacted).toContain(REDACTED);
    expect(redacted.startsWith('prefix ')).toBe(true);
  });

  it.each(['hello world', 'eyJ-not-a-jwt', 'sk-short', 'issue #42: token expired', 'xoxo'])(
    'leaves ordinary text alone: %p',
    (text) => {
      expect(looksLikeSecret(text)).toBe(false);
      expect(redactString(text)).toBe(text);
    },
  );

  it('redacts credential-like keys and token-shaped values deeply, without mutating input', () => {
    const input = {
      accessToken: 'anything',
      client_secret: 'x',
      password: 'p',
      maxTokens: 500,
      nested: [{ note: `use ${SAMPLES.slack} please`, cookie: 'session=1' }],
      when: new Date(0),
    };
    const out = redactSecrets(input);
    expect(out).toEqual({
      accessToken: REDACTED,
      client_secret: REDACTED,
      password: REDACTED,
      maxTokens: 500,
      nested: [{ note: `use ${REDACTED} please`, cookie: REDACTED }],
      when: new Date(0),
    });
    expect(input.accessToken).toBe('anything');
  });

  it('summarises errors without stack traces', () => {
    expect(redactSecrets({ err: new Error(`failed with ${SAMPLES.github}`) })).toEqual({
      err: { name: 'Error', message: `failed with ${REDACTED}` },
    });
  });

  it('leaves class instances (e.g. HTTP request objects) untouched', () => {
    class Req {
      headers = { authorization: 'Bearer abcdefghijklmnop' };
    }
    const req = new Req();
    expect(redactSecrets({ req }).req).toBe(req);
  });
});
