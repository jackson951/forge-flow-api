import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';
import { REQUEST_ID_HEADER } from '../constants';
import { resolveRequestId } from '../utils/request-id';

export interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
  details?: unknown;
  requestId?: string;
  path: string;
  timestamp: string;
}

interface NormalizedError {
  status: number;
  message: string | string[];
  details?: unknown;
}

/** Prisma errors that describe a client problem rather than a server fault. */
const PRISMA_ERROR_MAP: Record<string, NormalizedError> = {
  P2002: { status: HttpStatus.CONFLICT, message: 'Resource already exists' },
  P2025: { status: HttpStatus.NOT_FOUND, message: 'Resource not found' },
};

/**
 * Returns one sanitized error envelope to clients. Stack traces and internals
 * stay in server logs only.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();

    // Errors raised before the logging middleware (e.g. body parsing) have no req.id yet.
    const requestId = req.id ?? resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    if (!res.headersSent && !res.getHeader(REQUEST_ID_HEADER)) {
      res.setHeader(REQUEST_ID_HEADER, requestId);
    }

    const { status, message, details } = this.normalize(exception);
    // e.g. QueueBusyException (Part 21): tells clients when to try again.
    const retryAfter = (exception as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
    if (status === 429 && typeof retryAfter === 'number' && !res.headersSent) {
      res.setHeader('Retry-After', String(retryAfter));
    }

    if (status >= 500) {
      this.logger.error(
        { err: exception, requestId },
        exception instanceof Error ? exception.message : 'Unhandled exception',
      );
    }

    const body: ErrorResponseBody = {
      statusCode: status,
      error: STATUS_CODES[status] ?? 'Error',
      message,
      ...(details !== undefined && { details }),
      requestId,
      path: req.url,
      timestamp: new Date().toISOString(),
    };
    res.status(status).json(body);
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= 500) return { status, message: STATUS_CODES[status] ?? 'Error' };

      const response = exception.getResponse();
      if (typeof response === 'string') return { status, message: response };
      const { message, details } = response as { message?: string | string[]; details?: unknown };
      return { status, message: message ?? exception.message, details };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = PRISMA_ERROR_MAP[exception.code];
      if (mapped) return mapped;
    }

    // Client errors from Express middleware (http-errors objects marked safe to expose).
    const { status, expose } = (exception ?? {}) as { status?: unknown; expose?: unknown };
    if (typeof status === 'number' && status >= 400 && status < 500 && expose === true) {
      return { status, message: STATUS_CODES[status] ?? 'Error' };
    }

    return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
  }
}
