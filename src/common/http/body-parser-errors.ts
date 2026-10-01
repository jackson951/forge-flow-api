import { BadRequestException, HttpException, PayloadTooLargeException } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';

interface BodyParserError {
  type?: unknown;
  status?: unknown;
}

/**
 * Express error middleware registered right after the body parser. body-parser errors are
 * not Nest exceptions: "too large" would surface as a 500, and parse errors carry a message
 * that echoes part of the request body. Map them to generic, client-facing HttpExceptions.
 */
export function bodyParserErrorMapper(
  err: unknown,
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const { type, status } = (err ?? {}) as BodyParserError;
  if (type === 'entity.too.large')
    return next(new PayloadTooLargeException('Request body is too large'));
  if (type === 'entity.parse.failed') return next(new BadRequestException('Malformed JSON body'));
  if (typeof type === 'string' && typeof status === 'number' && status >= 400 && status < 500) {
    return next(new HttpException(STATUS_CODES[status] ?? 'Bad Request', status));
  }
  next(err);
}
