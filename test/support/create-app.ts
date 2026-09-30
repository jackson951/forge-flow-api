import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';

/** Boots the real AppModule with the same HTTP setup as `main.ts`. */
export async function createTestApp(
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<NestExpressApplication> {
  const moduleRef = await customize(Test.createTestingModule({ imports: [AppModule] })).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  configureApp(app);
  await app.init();
  return app;
}
