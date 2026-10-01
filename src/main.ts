import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true, // required for webhook signature verification
  });

  app.useLogger(app.get(Logger));
  configureApp(app);
  // SIGTERM/SIGINT → stop accepting connections, run shutdown hooks (Prisma, Redis, queues).
  app.enableShutdownHooks();

  const config = app.get(AppConfigService);
  await app.listen(config.get('PORT'));
  app.get(Logger).log(`FlowForge API listening on port ${config.get('PORT')}`);
}

void bootstrap();
