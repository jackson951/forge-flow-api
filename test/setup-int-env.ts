import { randomBytes } from 'node:crypto';
import { loadDotEnv, resolveTestDatabaseUrl } from './support/test-database';
import './support/block-external-http';

// Runs before each integration test file: point everything at the isolated test database.
loadDotEnv();
process.env.DATABASE_URL = resolveTestDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
// Many tests register users from one IP; the throttling test re-enables it explicitly.
process.env.THROTTLE_ENABLED ??= 'false';
// Unique BullMQ prefix per test file: never share queues with dev or with other files.
process.env.QUEUE_PREFIX ??= `ff-test-${process.pid}-${Date.now()}`;
// Fast retries in tests.
process.env.QUEUE_BACKOFF_MS ??= '50';
process.env.QUEUE_JOB_ATTEMPTS ??= '3';
// Enables the non-production TEST webhook provider.
process.env.WEBHOOK_TEST_SECRET ??= 'integration-test-webhook-secret';
// Credential encryption for tests: a fresh random key per test file (DB is truncated per
// suite). Forced, so keys from a developer's .env are never used by tests.
process.env.ENCRYPTION_KEYS = `test1:${randomBytes(32).toString('base64')}`;
process.env.ENCRYPTION_ACTIVE_KEY_ID = 'test1';
// AI steps use the deterministic fake; forced so a real key in .env is never used by tests.
process.env.AI_PROVIDER = 'fake';
process.env.AI_API_URL = 'http://127.0.0.1:9';
// Canary: configured but never used by the fake; tests assert it never leaks.
process.env.AI_API_KEY = 'test-ai-key-canary-not-real';
