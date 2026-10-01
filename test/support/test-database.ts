import { PrismaClient } from '@prisma/client';

/** Loads `.env` if present (CI provides env vars directly). */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // no .env file — rely on the environment
  }
}

/**
 * Integration tests reset their database, so they must never point at a real one.
 * Uses TEST_DATABASE_URL, or DATABASE_URL with `_test` appended to the database name.
 */
export function resolveTestDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL;
  const base = process.env.DATABASE_URL;
  if (!explicit && !base) throw new Error('Set TEST_DATABASE_URL or DATABASE_URL');

  const url = new URL(explicit ?? base!);
  if (!explicit) url.pathname = `${url.pathname}_test`;

  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to use database "${dbName}" for tests: name must end with _test`);
  }
  return url.toString();
}

/** Empties every application table between test files (keeps migration history). */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
}
