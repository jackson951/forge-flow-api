import { loadDotEnv, resolveTestDatabaseUrl } from './support/test-database';

// Runs before each integration test file: point everything at the isolated test database.
loadDotEnv();
process.env.DATABASE_URL = resolveTestDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
// Many tests register users from one IP; the throttling test re-enables it explicitly.
process.env.THROTTLE_ENABLED ??= 'false';
