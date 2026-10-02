import { ErrorCategory } from '@prisma/client';
import { ExecutionError, PermanentError, RetryableError } from '../../engine/errors';

/**
 * Network error codes meaning the request never reached the provider (DNS, connection
 * refused, unreachable, TLS handshake). Retrying these can never duplicate a side effect.
 */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);

export type FetchFailureKind = 'timeout' | 'not_sent' | 'unknown';

/** `fetch` (undici) wraps the cause: `TypeError('fetch failed', { cause: { code } })`. */
export function fetchFailureKind(err: unknown): FetchFailureKind {
  const e = err as {
    name?: string;
    code?: string;
    cause?: { code?: string; cause?: { code?: string } };
  };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  const code = e?.cause?.code ?? e?.code ?? e?.cause?.cause?.code;
  return code && NOT_SENT_CODES.has(code) ? 'not_sent' : 'unknown';
}

/**
 * Classifies a failed provider call (Part 15, S4):
 * - request never sent → retryable for everyone (safe);
 * - timeout or connection lost mid-request → the provider may have acted: for side-effecting
 *   calls this is UNCERTAIN_OUTCOME (never retried automatically), otherwise retryable.
 */
export function providerNetworkError(
  err: unknown,
  { provider, sideEffect }: { provider: string; sideEffect: boolean },
): ExecutionError {
  const kind = fetchFailureKind(err);
  if (kind === 'not_sent') {
    return new RetryableError(
      ErrorCategory.TRANSIENT_INFRASTRUCTURE,
      `Could not reach ${provider}`,
    );
  }
  if (sideEffect) {
    return new PermanentError(
      ErrorCategory.UNCERTAIN_OUTCOME,
      kind === 'timeout'
        ? `${provider} did not answer in time; the action may have been completed, so it is not retried automatically`
        : `The connection to ${provider} was lost mid-request; the action may have been completed, so it is not retried automatically`,
    );
  }
  return kind === 'timeout'
    ? new RetryableError(ErrorCategory.PROVIDER_TIMEOUT, `${provider} did not respond in time`)
    : new RetryableError(ErrorCategory.TRANSIENT_INFRASTRUCTURE, `Could not reach ${provider}`);
}
