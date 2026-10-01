import { Prisma } from '@prisma/client';
import { classifyError, PermanentError, RetryableError } from './errors';

describe('classifyError', () => {
  it('keeps the category and retryability of execution errors', () => {
    expect(classifyError(new RetryableError('PROVIDER_RATE_LIMIT', 'slow', 5_000))).toEqual({
      category: 'PROVIDER_RATE_LIMIT',
      retryable: true,
      message: 'slow',
      retryAfterMs: 5_000,
    });
    expect(classifyError(new PermanentError('PROVIDER_AUTH', 'revoked'))).toMatchObject({
      category: 'PROVIDER_AUTH',
      retryable: false,
    });
  });

  it('treats database connectivity errors as transient', () => {
    const err = new Prisma.PrismaClientKnownRequestError('cannot reach', {
      code: 'P1001',
      clientVersion: 'x',
    });
    expect(classifyError(err)).toMatchObject({
      category: 'TRANSIENT_INFRASTRUCTURE',
      retryable: true,
    });
  });

  it('treats unknown errors as INTERNAL, permanent, with a generic message', () => {
    expect(classifyError(new Error('secret detail'))).toEqual({
      category: 'INTERNAL',
      retryable: false,
      message: 'Internal error',
    });
  });

  it('truncates long messages', () => {
    expect(classifyError(new PermanentError('VALIDATION', 'x'.repeat(1_000))).message).toHaveLength(
      500,
    );
  });
});
