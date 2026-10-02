import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { APP_OPTIONS, configureApp } from './app.setup';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    ...APP_OPTIONS, // explicit JSON parsers only; webhooks keep their raw body (app.setup.ts)
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
