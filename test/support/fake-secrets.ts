/**
 * Fake credentials for redaction and encryption tests.
 *
 * Each value has the *shape* of a real provider credential (so the redactor is tested
 * against realistic input) but is assembled from pieces at runtime. That way no literal
 * matching a real secret format is stored in Git, and secret scanners such as GitHub Push
 * Protection have nothing to flag. None of these are, or ever were, real credentials.
 */
const join = (...parts: string[]) => parts.join('');

export const FAKE_SECRETS = {
  slack: join('xo', 'xb-', '1234567890-', '0987654321-', 'AbCdEfGhIjKlMnOp'),
  slackShort: join('xo', 'xb-', '1234567890-', 'abcdefghijkl'),
  slackRefresh: join('xo', 'xe-', 'canary-refresh-', 'token-0123456789'),
  slackAccess: join('xo', 'xb-', 'canary-access-', 'token-0123456789'),
  github: join('gh', 's_', '16C7e42F292c6912E7710c', '838347Ae178B4a'),
  githubUser: join('gh', 'u_', '16C7e42F292c6912E7710c', '838347Ae178B4a'),
  githubPat: join('github', '_pat_', '11ABCDEFG0123456789_', 'abcdefghijklmnopqrstuvwxyz'),
  jwt: join(
    'ey',
    'JhbGciOiJSUzI1NiJ9',
    '.',
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    '.',
    'c2lnbmF0dXJlc2lnbmF0dXJl',
  ),
  bearer: join('Bear', 'er ', 'abcdefghijklmnop', '.qrstu'),
  privateKey: join(
    '-----BEGIN RSA ',
    'PRIVATE KEY-----\n',
    'MIIEow\n',
    '-----END RSA ',
    'PRIVATE KEY-----',
  ),
  aiKey: join('sk', '-ant-', 'api03-', 'abcdefghijklmnopqrstuvwxyz0123'),
  awsKeyId: join('AK', 'IA', 'IOSFODNN7', 'EXAMPLE'),
} as const;
