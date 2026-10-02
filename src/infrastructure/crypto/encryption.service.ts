import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { decrypt, encrypt, Keyring, keyIdOf, parseKeyring } from './envelope';

/**
 * Encrypts third-party credentials at rest with the keys from ENCRYPTION_KEYS
 * (validated at startup). New values use ENCRYPTION_ACTIVE_KEY_ID; older key ids stay
 * readable until `credentials:reencrypt` has migrated every row.
 */
@Injectable()
export class EncryptionService {
  private readonly keyring?: Keyring;
  private readonly activeKeyId?: string;

  constructor(config: AppConfigService) {
    const keys = config.get('ENCRYPTION_KEYS');
    if (keys) {
      this.keyring = parseKeyring(keys);
      this.activeKeyId = config.get('ENCRYPTION_ACTIVE_KEY_ID');
    }
  }

  isConfigured(): boolean {
    return Boolean(this.keyring && this.activeKeyId);
  }

  get currentKeyId(): string {
    return this.require().activeKeyId;
  }

  encrypt(plaintext: string, aad: string): string {
    const { keyring, activeKeyId } = this.require();
    return encrypt(keyring, activeKeyId, plaintext, aad);
  }

  decrypt(envelope: string, aad: string): string {
    return decrypt(this.require().keyring, envelope, aad);
  }

  keyIdOf(envelope: string): string {
    return keyIdOf(envelope);
  }

  private require(): { keyring: Keyring; activeKeyId: string } {
    if (!this.keyring || !this.activeKeyId) {
      throw new ServiceUnavailableException('Credential encryption is not configured');
    }
    return { keyring: this.keyring, activeKeyId: this.activeKeyId };
  }
}
