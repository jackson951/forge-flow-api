import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true, // required for webhook signature verification
  });

  app.useLogger(app.get(Logger));
  const config = app.get(AppConfigService);
  const prefix = config.get('API_PREFIX');

  app.disable('x-powered-by');
  app.use(helmet());
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.setGlobalPrefix(prefix);
  app.enableShutdownHooks();

  if (!config.isProduction) {
    const doc = new DocumentBuilder()
      .setTitle('FlowForge API')
      .setDescription('Integration & workflow automation platform')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(`${prefix}/docs`, app, SwaggerModule.createDocument(app, doc));
  }

  await app.listen(config.get('PORT'));
}

void bootstrap();
