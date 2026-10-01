import { execSync } from 'node:child_process';
import { loadDotEnv, resolveTestDatabaseUrl } from '../support/test-database';

/**
 * Brings the isolated test database up to the latest migration (creating it if missing).
 * Non-destructive: tests empty the tables themselves via `truncateAll`. CI runs this against
 * a fresh Postgres service container, which proves the migrations build the schema from empty.
 */
export default function globalSetup(): void {
  loadDotEnv();
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: resolveTestDatabaseUrl() },
    stdio: 'pipe',
  });
}
