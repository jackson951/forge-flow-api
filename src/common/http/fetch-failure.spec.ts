import { ErrorCategory } from '@prisma/client';
import { PermanentError, RetryableError } from '../../engine/errors';
import { fetchFailureKind, providerNetworkError } from './fetch-failure';

const fetchFailed = (code: string) => new TypeError('fetch failed', { cause: { code } });
const timeout = () => Object.assign(new Error('aborted'), { name: 'TimeoutError' });

describe('provider network failures (Part 15, S4)', () => {
  it.each([
    ['ECONNREFUSED', 'not_sent'],
    ['ENOTFOUND', 'not_sent'],
    ['EAI_AGAIN', 'not_sent'],
    ['UND_ERR_CONNECT_TIMEOUT', 'not_sent'],
    ['ECONNRESET', 'unknown'],
    ['UND_ERR_SOCKET', 'unknown'],
  ])('%s → %s', (code, kind) => {
    expect(fetchFailureKind(fetchFailed(code))).toBe(kind);
  });

  it('recognises timeouts and unknown errors', () => {
    expect(fetchFailureKind(timeout())).toBe('timeout');
    expect(fetchFailureKind(new Error('boom'))).toBe('unknown');
  });

  it('a request that never left is retryable, even for side effects', () => {
    const err = providerNetworkError(fetchFailed('ECONNREFUSED'), {
      provider: 'Slack',
      sideEffect: true,
    });
    expect(err).toBeInstanceOf(RetryableError);
    expect(err.category).toBe(ErrorCategory.TRANSIENT_INFRASTRUCTURE);
  });

  it.each([
    ['timeout', timeout()],
    ['connection reset', fetchFailed('ECONNRESET')],
  ])('a %s on a side effect is UNCERTAIN_OUTCOME (never retried automatically)', (_name, cause) => {
    const err = providerNetworkError(cause, { provider: 'Slack', sideEffect: true });
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.category).toBe(ErrorCategory.UNCERTAIN_OUTCOME);
  });

  it('the same failures on reads are retryable', () => {
    expect(providerNetworkError(timeout(), { provider: 'X', sideEffect: false })).toMatchObject({
      category: ErrorCategory.PROVIDER_TIMEOUT,
      retryable: true,
    });
    expect(
      providerNetworkError(fetchFailed('ECONNRESET'), { provider: 'X', sideEffect: false }),
    ).toMatchObject({ category: ErrorCategory.TRANSIENT_INFRASTRUCTURE, retryable: true });
  });
});
