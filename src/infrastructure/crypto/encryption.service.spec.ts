import { ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service';
import { EncryptionService } from './encryption.service';

const key = () => randomBytes(32).toString('base64');
const service = (env: Record<string, string | undefined>) =>
  new EncryptionService({ get: (k: string) => env[k] } as unknown as AppConfigService);

describe('EncryptionService', () => {
  const k1 = key();
  const k2 = key();

  it('encrypts with the active key and decrypts with any configured key', () => {
    const old = service({ ENCRYPTION_KEYS: `k1:${k1}`, ENCRYPTION_ACTIVE_KEY_ID: 'k1' });
    const rotated = service({
      ENCRYPTION_KEYS: `k1:${k1},k2:${k2}`,
      ENCRYPTION_ACTIVE_KEY_ID: 'k2',
    });

    const sealedWithK1 = old.encrypt('secret', 'conn:accessToken');
    expect(old.keyIdOf(sealedWithK1)).toBe('k1');
    expect(rotated.decrypt(sealedWithK1, 'conn:accessToken')).toBe('secret');

    const sealedWithK2 = rotated.encrypt('secret', 'conn:accessToken');
    expect(rotated.currentKeyId).toBe('k2');
    expect(rotated.keyIdOf(sealedWithK2)).toBe('k2');
    expect(() => old.decrypt(sealedWithK2, 'conn:accessToken')).toThrow();
  });

  it('reports itself unconfigured and refuses to work without keys', () => {
    const none = service({});
    expect(none.isConfigured()).toBe(false);
    expect(() => none.encrypt('x', 'aad')).toThrow(ServiceUnavailableException);
    expect(() => none.decrypt('v1.k.a.b.c', 'aad')).toThrow(ServiceUnavailableException);
    expect(() => none.currentKeyId).toThrow('Credential encryption is not configured');
    expect(
      service({ ENCRYPTION_KEYS: `k1:${k1}`, ENCRYPTION_ACTIVE_KEY_ID: 'k1' }).isConfigured(),
    ).toBe(true);
  });
});
