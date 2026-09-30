import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Returns sanitized error bodies to clients. Stack traces and internals
 * stay in server logs only.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const body = exception instanceof HttpException ? exception.getResponse() : null;
    const message =
      status === HttpStatus.INTERNAL_SERVER_ERROR
        ? 'Internal server error'
        : typeof body === 'string'
          ? body
          : ((body as { message?: unknown } | null)?.message ?? 'Error');

    if (status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    res.status(status).json({
      statusCode: status,
      message,
      requestId: req.id,
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
