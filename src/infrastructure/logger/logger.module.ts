import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { REQUEST_ID_HEADER } from '../../common/constants';
import { REDACTED_PATHS } from '../../common/utils/redact';
import { resolveRequestId } from '../../common/utils/request-id';
import { AppConfigService } from '../../config/app-config.service';

/** Structured JSON logs with a per-request correlation ID. */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
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
        },
      }),
    }),
  ],
})
export class LoggerModule {}
