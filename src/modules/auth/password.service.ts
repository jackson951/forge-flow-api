import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * argon2id with the library defaults (m=64 MiB, t=3, p=4), above the OWASP minimums.
 * The encoded hash carries its parameters, so they can be raised later without migration.
 */
@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  /** Never throws: malformed or deliberately unusable hashes simply fail verification. */
  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /**
   * Spends the same work as a real verification when the email is unknown, so response
   * timing does not reveal which emails are registered. Always resolves to false.
   */
  async verifyAgainstDummy(password: string): Promise<false> {
    this.dummyHash ??= this.hash('flowforge-dummy-password-for-timing');
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
