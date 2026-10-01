import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  Logger,
  NotImplementedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter, ErrorResponseBody } from './all-exceptions.filter';

function run(exception: unknown): { status: number; body: ErrorResponseBody } {
  const result = { status: 0, body: undefined as unknown as ErrorResponseBody };
  const res = {
    status(code: number) {
      result.status = code;
      return this;
    },
    json(body: ErrorResponseBody) {
      result.body = body;
    },
  };
  const req = { id: 'req-1', url: '/api/v1/thing' };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;

  new AllExceptionsFilter().catch(exception, host);
  return result;
}

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('db detail: constraint users_email_key', {
    code,
    clientVersion: 'test',
  });

describe('AllExceptionsFilter', () => {
  beforeAll(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
  afterAll(() => jest.restoreAllMocks());

  it('wraps HttpExceptions in the standard envelope', () => {
    const { status, body } = run(new ForbiddenException('Nope'));
    expect(status).toBe(403);
    expect(body).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Nope',
      requestId: 'req-1',
      path: '/api/v1/thing',
      timestamp: expect.any(String),
    });
  });

  it('includes validation details', () => {
    const details = [{ field: 'email', messages: ['email must be an email'] }];
    const { status, body } = run(
      new BadRequestException({ message: 'Validation failed', details }),
    );
    expect(status).toBe(400);
    expect(body.message).toBe('Validation failed');
    expect(body.details).toEqual(details);
  });

  it('maps Prisma unique violations to 409 without leaking internals', () => {
    const { status, body } = run(prismaError('P2002'));
    expect(status).toBe(409);
    expect(body.message).toBe('Resource already exists');
    expect(JSON.stringify(body)).not.toContain('users_email_key');
  });

  it('maps Prisma record-not-found to 404', () => {
    expect(run(prismaError('P2025')).status).toBe(404);
  });

  it('hides unknown Prisma errors as 500', () => {
    const { status, body } = run(prismaError('P1001'));
    expect(status).toBe(500);
    expect(body.message).toBe('Internal server error');
  });

  it('hides unexpected errors and their messages', () => {
    const { status, body } = run(new Error('password=hunter2 at db.ts:42'));
    expect(status).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('uses the generic status text for 5xx HttpExceptions', () => {
    const { status, body } = run(new NotImplementedException('internal detail'));
    expect(status).toBe(501);
    expect(body.message).toBe('Not Implemented');
  });
});
