import { VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { json, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { REQUEST_ID_HEADER } from './common/constants';
import { withStandardResponses } from './common/http/api-docs';
import { bodyParserErrorMapper } from './common/http/body-parser-errors';
import { AppConfigService } from './config/app-config.service';

export const DEFAULT_API_VERSION = '1';

/**
 * Options for `NestFactory.create` (main.ts and tests). Nest's default body parsers are off:
 * only the JSON parsers below are registered, so URL-encoded and other bodies are never
 * parsed (OAuth callbacks use the query string).
 */
export const APP_OPTIONS = { bufferLogs: true, bodyParser: false } as const;

/**
 * Global JSON limit (Part 18). Must fit the largest legal workflow draft: a 256 KB
 * definition (DEFINITION_LIMITS) plus the request envelope — hence 300 KB, not 256 KB.
 */
export const JSON_BODY_LIMIT = '300kb';

/** Provider payloads can be larger than API requests (GitHub caps at 25 MB; issue events are small). */
export const WEBHOOK_BODY_LIMIT = '1mb';

/**
 * HTTP-level setup shared by `main.ts` and the e2e tests, so tests exercise
 * exactly the prefix, versioning and security headers that production runs.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(AppConfigService);
  const prefix = config.get('API_PREFIX');

  app.disable('x-powered-by');
  // Hop count of trusted reverse proxies, so req.ip (rate limits, audit) is the client's.
  app.set('trust proxy', config.get('TRUST_PROXY'));
  // Webhooks first: larger limit, and the exact raw bytes are kept for signature checks.
  app.use(
    `/${prefix}/v1/webhooks`,
    json({
      limit: WEBHOOK_BODY_LIMIT,
      verify: (req, _res, buf) => {
        (req as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(json({ limit: JSON_BODY_LIMIT }));
  app.use(bodyParserErrorMapper);

  // A JSON API serves no documents: deny everything by default. The Swagger UI (HTML, own
  // scripts and styles) gets helmet's standard policy instead.
  const docsPath = `/${prefix}/docs`;
  const apiHelmet = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  const docsHelmet = helmet({ crossOriginResourcePolicy: { policy: 'same-site' } });
  app.use((req: Request, res: Response, next: NextFunction) =>
    (req.path.startsWith(docsPath) ? docsHelmet : apiHelmet)(req, res, next),
  );
  app.use(cookieParser());
  app.enableCors({
    origin: config.corsOrigins, // explicit list; never a wildcard (credentials are allowed)
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', REQUEST_ID_HEADER],
    exposedHeaders: [REQUEST_ID_HEADER, 'Retry-After'],
    maxAge: 600,
  });
  app.setGlobalPrefix(prefix);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: DEFAULT_API_VERSION });

  if (config.swaggerEnabled) {
    const doc = new DocumentBuilder()
      .setTitle('FlowForge API')
      .setDescription(
        'Integration & workflow automation platform.\n\n' +
          'Rate limits (per minute): 300 per user on authenticated routes; login 5 per IP+email and 20 per IP; ' +
          'register 5 and refresh 30 per IP; webhooks 600 per provider per IP. Exceeding a limit returns ' +
          '429 with a Retry-After header (seconds). JSON bodies above 300 KB (1 MB on webhooks) return 413.',
      )
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(
      `${prefix}/docs`,
      app,
      withStandardResponses(SwaggerModule.createDocument(app, doc)),
    );
  }
}
