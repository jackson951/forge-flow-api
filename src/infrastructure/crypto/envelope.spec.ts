import { randomBytes } from 'node:crypto';
import { FAKE_SECRETS } from '../../../test/support/fake-secrets';
import { decrypt, encrypt, EncryptionError, keyIdOf, parseKeyring } from './envelope';

const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');
const keyring = parseKeyring(`k1:${k1}, k2:${k2}`);
const AAD = 'conn-1:accessToken';
const SECRET = FAKE_SECRETS.slackAccess;

describe('envelope encryption', () => {
  it('round-trips and never contains the plaintext', () => {
    const envelope = encrypt(keyring, 'k1', SECRET, AAD);
    expect(envelope).toMatch(/^v1\.k1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
    expect(envelope).not.toContain(SECRET);
    expect(decrypt(keyring, envelope, AAD)).toBe(SECRET);
    expect(keyIdOf(envelope)).toBe('k1');
  });

  it('uses a fresh IV every time', () => {
    expect(encrypt(keyring, 'k1', SECRET, AAD)).not.toBe(encrypt(keyring, 'k1', SECRET, AAD));
  });

  it('decrypts values written with any configured key (rotation)', () => {
    const old = encrypt(keyring, 'k2', SECRET, AAD);
    expect(decrypt(keyring, old, AAD)).toBe(SECRET);
  });

  it('rejects a ciphertext moved to another row or field (AAD)', () => {
    const envelope = encrypt(keyring, 'k1', SECRET, AAD);
    expect(() => decrypt(keyring, envelope, 'conn-2:accessToken')).toThrow(EncryptionError);
    expect(() => decrypt(keyring, envelope, 'conn-1:refreshToken')).toThrow(EncryptionError);
  });

  it.each([2, 3, 4])('rejects tampering with part %d', (index) => {
    const parts = encrypt(keyring, 'k1', SECRET, AAD).split('.');
    const bytes = Buffer.from(parts[index], 'base64url');
    bytes[0] ^= 0xff;
    parts[index] = bytes.toString('base64url');
    expect(() => decrypt(keyring, parts.join('.'), AAD)).toThrow(EncryptionError);
  });

  it('rejects the wrong key, unknown key ids and malformed input', () => {
    const envelope = encrypt(keyring, 'k1', SECRET, AAD);
    const swapped = parseKeyring(`k1:${k2}`);
    expect(() => decrypt(swapped, envelope, AAD)).toThrow('decryption failed');
    expect(() => decrypt(parseKeyring(`k9:${k1}`), envelope, AAD)).toThrow('unknown key id');
    expect(() => decrypt(keyring, 'not-an-envelope', AAD)).toThrow('unsupported ciphertext format');
    expect(() => encrypt(keyring, 'nope', SECRET, AAD)).toThrow('unknown key id');
  });

  it('error messages never contain key material or plaintext', () => {
    try {
      decrypt(parseKeyring(`k1:${k2}`), encrypt(keyring, 'k1', SECRET, AAD), AAD);
    } catch (err) {
      expect((err as Error).message).not.toContain(SECRET);
      expect((err as Error).message).not.toContain(k1);
    }
  });
});

describe('parseKeyring', () => {
  it.each([
    ['', 'no keys configured'],
    [`k1:${randomBytes(16).toString('base64')}`, 'must be 32 bytes'],
    [`bad id!:${k1}`, 'invalid key id'],
    [k1, 'invalid key id'],
    [`k1:${k1},k1:${k2}`, 'duplicate key id'],
  ])('rejects %p', (value, reason) => {
    expect(() => parseKeyring(value)).toThrow(reason);
  });
});
