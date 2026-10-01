// Runs before each e2e test file, i.e. before ConfigModule reads the environment.
// Values already set in the shell/CI win; `.env` fills the rest (DATABASE_URL, secrets).
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
// Many tests register users from one IP; the throttling test re-enables it explicitly.
process.env.THROTTLE_ENABLED ??= 'false';
