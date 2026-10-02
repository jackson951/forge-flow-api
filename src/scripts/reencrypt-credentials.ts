import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppConfigModule } from '../config/app-config.module';
import { CryptoModule } from '../infrastructure/crypto/crypto.module';
import { LoggerModule } from '../infrastructure/logger/logger.module';
import { PrismaModule } from '../infrastructure/prisma/prisma.module';
import { CredentialStore } from '../modules/integrations/credentials/credential-store';

/**
 * Key rotation, step 2 of 3 (docs/backend/17-INTEGRATION-CREDENTIAL-SECURITY.md):
 *   1. add the new key to ENCRYPTION_KEYS and make it ENCRYPTION_ACTIVE_KEY_ID (keep the old key)
 *   2. run `npm run credentials:reencrypt`
 *   3. remove the old key from ENCRYPTION_KEYS
 */
@Module({
  imports: [AppConfigModule, LoggerModule, PrismaModule, CryptoModule],
  providers: [CredentialStore],
})
class ReencryptModule {}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ReencryptModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  try {
    const { updated, failedConnectionIds } = await app.get(CredentialStore).reencryptAll();
    app.get(Logger).log(`Re-encrypted ${updated} credential row(s) with the active key`);
    if (failedConnectionIds.length) {
      app
        .get(Logger)
        .warn(
          `${failedConnectionIds.length} credential(s) could not be decrypted and were left unchanged; ` +
            `keep the old key and reconnect these connections: ${failedConnectionIds.join(', ')}`,
        );
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

void main();
