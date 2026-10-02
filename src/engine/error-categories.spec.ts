import { ErrorCategory } from '@prisma/client';
import { describeError, ERROR_CATEGORIES } from './error-categories';
import { classifyError, PermanentError, RetryableError } from './errors';

describe('error category catalogue (Part 16)', () => {
  it('covers every category exactly once, each with a description', () => {
    expect(Object.keys(ERROR_CATEGORIES).sort()).toEqual(Object.values(ErrorCategory).sort());
    for (const info of Object.values(ERROR_CATEGORIES))
      expect(info.description.length).toBeGreaterThan(10);
  });

  it('marks exactly the transient categories as retryable', () => {
    const retryable = Object.entries(ERROR_CATEGORIES)
      .filter(([, info]) => info.retryable)
      .map(([category]) => category)
      .sort();
    expect(retryable).toEqual([
      'PROVIDER_RATE_LIMIT',
      'PROVIDER_TIMEOUT',
      'TRANSIENT_INFRASTRUCTURE',
    ]);
  });

  it('agrees with how the built-in error classes are classified', () => {
    expect(classifyError(new Error('bug')).retryable).toBe(ERROR_CATEGORIES.INTERNAL.retryable);
    expect(classifyError(new RetryableError(ErrorCategory.PROVIDER_TIMEOUT, 'x')).retryable).toBe(
      ERROR_CATEGORIES.PROVIDER_TIMEOUT.retryable,
    );
    expect(classifyError(new PermanentError(ErrorCategory.UNCERTAIN_OUTCOME, 'x')).retryable).toBe(
      ERROR_CATEGORIES.UNCERTAIN_OUTCOME.retryable,
    );
  });

  it('describes an error for the API', () => {
    expect(describeError(null, null)).toBeNull();
    expect(describeError(ErrorCategory.PROVIDER_AUTH, 'reconnect')).toEqual({
      category: 'PROVIDER_AUTH',
      message: 'reconnect',
      retryable: false,
      description: expect.stringContaining('reconnect the integration'),
    });
  });
});
