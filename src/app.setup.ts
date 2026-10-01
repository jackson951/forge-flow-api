import { VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { REQUEST_ID_HEADER } from './common/constants';
import { bodyParserErrorMapper } from './common/http/body-parser-errors';
import { AppConfigService } from './config/app-config.service';

export const DEFAULT_API_VERSION = '1';

/** Fits the largest allowed workflow definition (256 KB) plus request envelope; Part 18 tunes. */
export const JSON_BODY_LIMIT = '300kb';

/**
 * HTTP-level setup shared by `main.ts` and the e2e tests, so tests exercise
 * exactly the prefix, versioning and security headers that production runs.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(AppConfigService);
  const prefix = config.get('API_PREFIX');

  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.use(bodyParserErrorMapper);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    exposedHeaders: [REQUEST_ID_HEADER],
  });
  app.setGlobalPrefix(prefix);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: DEFAULT_API_VERSION });

  if (config.swaggerEnabled) {
    const doc = new DocumentBuilder()
      .setTitle('FlowForge API')
      .setDescription('Integration & workflow automation platform')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(`${prefix}/docs`, app, SwaggerModule.createDocument(app, doc));
  }
}
