import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const passwords = new PasswordService();
  let hash: string;

  beforeAll(async () => {
    hash = await passwords.hash('correct horse battery staple');
  });

  it('produces an argon2id hash that does not contain the password', () => {
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    expect(hash).not.toContain('correct horse');
  });

  it('salts every hash', async () => {
    expect(await passwords.hash('correct horse battery staple')).not.toBe(hash);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    await expect(passwords.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(passwords.verify(hash, 'Correct horse battery staple')).resolves.toBe(false);
  });

  it('treats malformed or deliberately unusable hashes as a failed match', async () => {
    await expect(passwords.verify('!seed-account-login-disabled', 'anything')).resolves.toBe(false);
    await expect(passwords.verify('', 'anything')).resolves.toBe(false);
  });

  it('dummy verification always fails', async () => {
    await expect(passwords.verifyAgainstDummy('anything')).resolves.toBe(false);
  });
});
