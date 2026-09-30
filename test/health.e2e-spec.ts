import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { HealthModule } from '../src/modules/health/health.module';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HealthModule],
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(() => app.close());

  it('GET /api/health is public', () =>
    request(app.getHttpServer()).get('/api/health').expect(200));
});
