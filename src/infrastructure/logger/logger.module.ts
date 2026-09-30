import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { REQUEST_ID_HEADER } from '../../common/constants';
import { REDACTED_PATHS } from '../../common/utils/redact';
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
            const incoming = req.headers[REQUEST_ID_HEADER];
            const id = (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
            res.setHeader(REQUEST_ID_HEADER, id);
            return id;
          },
          transport: config.isProduction
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
        },
      }),
    }),
  ],
})
export class LoggerModule {}
