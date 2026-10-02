// Imported first by reliability.int-spec.ts, before any application module is loaded:
// short job locks so a "crashed" worker's job is redelivered within a second, and a short
// step timeout for the timeout scenarios.
process.env.WORKER_LOCK_DURATION_MS = '1000';
process.env.NODE_TIMEOUT_MS = '5000';
