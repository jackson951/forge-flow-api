import Redis from 'ioredis';
import { execSync } from 'node:child_process';
import { loadDotEnv, resolveTestDatabaseUrl } from '../support/test-database';

const HELP =
  'Integration and E2E tests need PostgreSQL and Redis. Start them with ' +
  '`docker compose up -d postgres redis` (or point DATABASE_URL / REDIS_HOST at running ' +
  'instances). The tests never skip silently.';

/**
 * Runs once before the integration/E2E suites: checks that Redis answers and brings the
 * isolated test database up to the latest migration (creating it if missing). Non-destructive:
 * tests empty the tables themselves via `truncateAll`. CI runs this against fresh service
 * containers, which proves the migrations build the schema from empty.
 */
export default async function globalSetup(): Promise<void> {
  loadDotEnv();

  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: true,
    connectTimeout: 3_000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    throw new Error(`Redis is not reachable (${(err as Error).message}).\n${HELP}`);
  } finally {
    redis.disconnect();
  }

  try {
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: resolveTestDatabaseUrl() },
      stdio: 'pipe',
    });
  } catch (err) {
    const output = String((err as { stderr?: Buffer }).stderr ?? '').trim();
    throw new Error(
      `Could not prepare the test database (prisma migrate deploy failed).\n${output}\n${HELP}`,
    );
  }
}
