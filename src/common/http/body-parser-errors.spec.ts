import { BadRequestException, HttpException, PayloadTooLargeException } from '@nestjs/common';
import { Request, Response } from 'express';
import { bodyParserErrorMapper } from './body-parser-errors';

const map = (err: unknown) => {
  const next = jest.fn();
  bodyParserErrorMapper(err, {} as Request, {} as Response, next);
  return next.mock.calls[0][0] as unknown;
};

describe('bodyParserErrorMapper', () => {
  it('maps "too large" to 413', () => {
    const mapped = map({ type: 'entity.too.large', status: 413 });
    expect(mapped).toBeInstanceOf(PayloadTooLargeException);
    expect((mapped as HttpException).message).toBe('Request body is too large');
  });

  it('maps parse failures to a generic 400 that does not echo the body', () => {
    const mapped = map(
      Object.assign(new SyntaxError('Unexpected token s in JSON: {"secret": s'), {
        type: 'entity.parse.failed',
        status: 400,
      }),
    );
    expect(mapped).toBeInstanceOf(BadRequestException);
    expect((mapped as HttpException).message).toBe('Malformed JSON body');
  });

  it('maps other body-parser client errors by status', () => {
    const mapped = map({ type: 'encoding.unsupported', status: 415 }) as HttpException;
    expect(mapped.getStatus()).toBe(415);
  });

  it('passes unrelated errors through unchanged', () => {
    const err = new Error('boom');
    expect(map(err)).toBe(err);
  });
});
