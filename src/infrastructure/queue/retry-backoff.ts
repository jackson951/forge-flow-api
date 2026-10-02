import { BackoffStrategy } from 'bullmq';

/** Job backoff type handled by `runBackoffStrategy` (registered on the run worker). */
export const RUN_BACKOFF_TYPE = 'flowforge';

/** Upper bound for any single retry delay, including provider-requested ones. */
export const MAX_RETRY_DELAY_MS = 15 * 60_000;

const JITTER = 0.3;

/**
 * Delay before the next attempt of a run job. A provider's requested wait (`Retry-After`,
 * carried as `retryAfterMs` on rate-limit errors) wins; otherwise exponential backoff from
 * `baseMs` with ±30 % jitter. Both are capped at MAX_RETRY_DELAY_MS.
 */
export function runRetryDelay(
  attemptsMade: number,
  baseMs: number,
  err?: Error,
  random: () => number = Math.random,
): number {
  const requested = (err as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.ceil(requested), MAX_RETRY_DELAY_MS);
  }
  const delay = baseMs * 2 ** Math.max(0, attemptsMade - 1);
  return Math.min(Math.floor(delay * (1 - JITTER) + random() * delay * JITTER), MAX_RETRY_DELAY_MS);
}

export const runBackoffStrategy: BackoffStrategy = (attemptsMade, _type, err, job) => {
  const backoff = job?.opts.backoff;
  const baseMs = typeof backoff === 'object' && backoff.delay ? backoff.delay : 1_000;
  return runRetryDelay(attemptsMade, baseMs, err);
};
