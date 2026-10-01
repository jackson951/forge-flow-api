// Runs before each e2e test file, i.e. before ConfigModule reads the environment.
// Values already set in the shell/CI win; `.env` fills the rest (DATABASE_URL, secrets).
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
// Many tests register users from one IP; the throttling test re-enables it explicitly.
process.env.THROTTLE_ENABLED ??= 'false';
// Unique BullMQ prefix per test file: never share queues with dev or with other files.
process.env.QUEUE_PREFIX ??= `ff-test-${process.pid}-${Date.now()}`;
// Fast retries in tests.
process.env.QUEUE_BACKOFF_MS ??= '50';
process.env.QUEUE_JOB_ATTEMPTS ??= '3';
