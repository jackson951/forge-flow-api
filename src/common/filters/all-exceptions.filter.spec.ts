import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  Logger,
  NotImplementedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter, ErrorResponseBody } from './all-exceptions.filter';

function run(
  exception: unknown,
  req: { id?: string; url: string; headers: Record<string, string> } = {
    id: 'req-1',
    url: '/api/v1/thing',
    headers: {},
  },
): { status: number; body: ErrorResponseBody; headers: Record<string, string> } {
  const result = {
    status: 0,
    body: undefined as unknown as ErrorResponseBody,
    headers: {} as Record<string, string>,
  };
  const res = {
    headersSent: false,
    getHeader: (name: string) => result.headers[name],
    setHeader: (name: string, value: string) => {
      result.headers[name] = value;
    },
    status(code: number) {
      result.status = code;
      return this;
    },
    json(body: ErrorResponseBody) {
      result.body = body;
    },
  };
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

  it('passes through exposable client errors from Express middleware', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      expose: true,
      type: 'entity.too.large',
    });
    const { status, body } = run(tooLarge);
    expect(status).toBe(413);
    expect(body.message).toBe('Payload Too Large');
  });

  it('does not trust non-exposable status codes', () => {
    expect(run(Object.assign(new Error('x'), { status: 404, expose: false })).status).toBe(500);
  });

  it('generates a request id when the logging middleware has not run yet', () => {
    const { body, headers } = run(new BadRequestException('Malformed JSON body'), {
      url: '/api/v1/auth/login',
      headers: { 'x-request-id': 'client-id-1' },
    });
    expect(body.requestId).toBe('client-id-1');
    expect(headers['x-request-id']).toBe('client-id-1');
  });

  it('uses the generic status text for 5xx HttpExceptions', () => {
    const { status, body } = run(new NotImplementedException('internal detail'));
    expect(status).toBe(501);
    expect(body.message).toBe('Not Implemented');
  });
});
