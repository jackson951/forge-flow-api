import { Injectable, NotImplementedException } from '@nestjs/common';

/** Encrypts third-party tokens/secrets at rest (e.g. AES-256-GCM). */
@Injectable()
export class EncryptionService {
  encrypt(_plaintext: string): string {
    throw new NotImplementedException();
  }

  decrypt(_ciphertext: string): string {
    throw new NotImplementedException();
  }
}
