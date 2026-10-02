import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for secrets at rest. Pure functions, no Nest.
 *
 *   v1.<keyId>.<iv>.<tag>.<ciphertext>        (base64url parts)
 *
 * - AES-256-GCM, random 96-bit IV per encryption, 128-bit tag.
 * - Additional authenticated data (AAD) binds a ciphertext to where it belongs, e.g.
 *   "<connectionId>:accessToken": a ciphertext copied to another row or field fails to decrypt.
 * - The key id lets several keys coexist during rotation.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export type Keyring = ReadonlyMap<string, Buffer>;

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

/** Parses "k1:<base64 32 bytes>,k2:<base64 32 bytes>". Throws with a readable reason. */
export function parseKeyring(value: string): Keyring {
  const keys = new Map<string, Buffer>();
  for (const entry of value
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(':');
    const id = entry.slice(0, separator);
    const key = Buffer.from(entry.slice(separator + 1), 'base64');
    if (separator < 1 || !KEY_ID.test(id))
      throw new EncryptionError(`invalid key id in "${id || entry.slice(0, 8)}…"`);
    if (key.length !== 32)
      throw new EncryptionError(`key "${id}" must be 32 bytes (base64), got ${key.length}`);
    if (keys.has(id)) throw new EncryptionError(`duplicate key id "${id}"`);
    keys.set(id, key);
  }
  if (keys.size === 0) throw new EncryptionError('no keys configured');
  return keys;
}

export function encrypt(keyring: Keyring, keyId: string, plaintext: string, aad: string): string {
  const key = keyring.get(keyId);
  if (!key) throw new EncryptionError(`unknown key id "${keyId}"`);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const parts = [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64url'));
  return [VERSION, keyId, ...parts].join('.');
}

export function decrypt(keyring: Keyring, envelope: string, aad: string): string {
  const { keyId, iv, tag, ciphertext } = parseEnvelope(envelope);
  const key = keyring.get(keyId);
  if (!key) throw new EncryptionError(`unknown key id "${keyId}"`);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Never echo ciphertext or key material.
    throw new EncryptionError('decryption failed (wrong key, wrong context or tampered data)');
  }
}

export function keyIdOf(envelope: string): string {
  return parseEnvelope(envelope).keyId;
}

function parseEnvelope(envelope: string) {
  const parts = envelope.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION)
    throw new EncryptionError('unsupported ciphertext format');
  const [, keyId, iv, tag, ciphertext] = parts;
  const decoded = {
    keyId,
    iv: Buffer.from(iv, 'base64url'),
    tag: Buffer.from(tag, 'base64url'),
    ciphertext: Buffer.from(ciphertext, 'base64url'),
  };
  if (decoded.iv.length !== 12 || decoded.tag.length !== 16) {
    throw new EncryptionError('unsupported ciphertext format');
  }
  return decoded;
}
