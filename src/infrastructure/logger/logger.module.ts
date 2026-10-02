import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { Options } from 'pino-http';
import { REQUEST_ID_HEADER } from '../../common/constants';
import { redactSecrets } from '../../common/security/redaction';
import { REDACTED_PATHS, redactQuery, redactQueryString } from '../../common/utils/redact';
import { resolveRequestId } from '../../common/utils/request-id';
import { AppConfigService } from '../../config/app-config.service';

/**
 * Logger options, exported so tests can prove what reaches the output.
 * Two redaction nets: fixed paths (headers, known secret fields) and value-based scrubbing
 * of token-shaped strings anywhere in a log object (Part 17).
 */
export function buildLoggerOptions(config: AppConfigService): Options {
  return {
    level: config.get('LOG_LEVEL'),
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    formatters: { log: (object: Record<string, unknown>) => redactSecrets(object) },
    // OAuth callbacks carry one-time secrets in the query string (`code`, `state`).
    serializers: {
      req: (req: { url?: string; query?: unknown }) => {
        if (req.url) req.url = redactQueryString(req.url);
        if (req.query) req.query = redactQuery(req.query);
        return req;
      },
    },
    genReqId: (req, res) => {
      const id = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    // Probes hit these every few seconds; logging them drowns out real traffic.
    autoLogging: { ignore: (req) => req.url?.includes('/health') ?? false },
    // pino-pretty runs in a worker thread; only use it for interactive development.
    transport:
      config.get('NODE_ENV') === 'development'
        ? { target: 'pino-pretty', options: { singleLine: true } }
        : undefined,
  };
}

/** Structured JSON logs with a per-request correlation ID. */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({ pinoHttp: buildLoggerOptions(config) }),
    }),
  ],
})
export class LoggerModule {}
