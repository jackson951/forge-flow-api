import { NestExpressApplication } from '@nestjs/platform-express';
import Redis from 'ioredis';
import request from 'supertest';
import { AppConfigService } from '../src/config/app-config.service';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/infrastructure/redis/redis.module';
import { createTestApp } from './support/create-app';

/**
 * Requires PostgreSQL and Redis (`docker compose up -d postgres redis`)
 * and DATABASE_URL / JWT secrets from `.env` or the shell.
 */
describe('Foundation (e2e)', () => {
  let app: NestExpressApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
  });

  afterAll(() => app.close());

  describe('health', () => {
    it('GET /api/v1/health → 200 liveness', async () => {
      const res = await http.get('/api/v1/health').expect(200);
      expect(res.body).toEqual({ status: 'ok', timestamp: expect.any(String) });
    });

    it('GET /api/v1/health/ready → 200 with Postgres and Redis up', async () => {
      const res = await http.get('/api/v1/health/ready').expect(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        checks: { database: { status: 'up' }, redis: { status: 'up' } },
      });
    });

    it('unversioned path is not routed', () => http.get('/api/health').expect(404));
  });

  describe('errors and validation', () => {
    it('rejects an invalid body with 400 and field details', async () => {
      const res = await http
        .post('/api/v1/auth/register')
        .send({ email: 'not-an-email', password: 'short', role: 'admin' })
        .expect(400);

      expect(res.body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        path: '/api/v1/auth/register',
        requestId: expect.any(String),
      });
      const fields = (res.body.details as { field: string }[]).map((d) => d.field);
      expect(fields).toEqual(expect.arrayContaining(['email', 'password', 'name', 'role']));
    });

    it('protected routes stay secure by default (401 envelope)', async () => {
      const res = await http.get('/api/v1/workflows').expect(401);
      expect(res.body).toMatchObject({ statusCode: 401, error: 'Unauthorized' });
    });

    it('unknown routes return the standard 404 envelope', async () => {
      const res = await http.get('/api/v1/does-not-exist').expect(404);
      expect(res.body).toMatchObject({ statusCode: 404, path: '/api/v1/does-not-exist' });
    });
  });

  describe('correlation ids', () => {
    it('echoes a well-formed x-request-id in header and error body', async () => {
      const res = await http.get('/api/v1/nope').set('x-request-id', 'trace-abc_123').expect(404);
      expect(res.headers['x-request-id']).toBe('trace-abc_123');
      expect(res.body.requestId).toBe('trace-abc_123');
    });

    it('replaces a malformed x-request-id', async () => {
      const res = await http.get('/api/v1/health').set('x-request-id', 'bad id!').expect(200);
      expect(res.headers['x-request-id']).not.toBe('bad id!');
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('security headers and CORS', () => {
    it('sets Helmet headers and hides X-Powered-By', async () => {
      const res = await http.get('/api/v1/health').expect(200);
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['content-security-policy']).toBeDefined();
    });

    it('allows configured origins', async () => {
      const origin = app.get(AppConfigService).corsOrigins[0];
      const res = await http
        .options('/api/v1/health')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'GET')
        .expect(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('does not allow other origins', async () => {
      const res = await http
        .get('/api/v1/health')
        .set('Origin', 'https://evil.example.com')
        .expect(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('swagger', () => {
    it('serves the OpenAPI document outside production', async () => {
      const res = await http.get('/api/docs-json').expect(200);
      expect(res.body.info.title).toBe('FlowForge API');
      expect(Object.keys(res.body.paths)).toContain('/api/v1/health/ready');
    });
  });
});

describe('Swagger disabled (e2e)', () => {
  class NoSwaggerConfig extends AppConfigService {
    override get swaggerEnabled(): boolean {
      return false;
    }
  }

  it('does not serve docs when SWAGGER_ENABLED=false', async () => {
    const app = await createTestApp((b) =>
      b.overrideProvider(AppConfigService).useClass(NoSwaggerConfig),
    );
    try {
      await request(app.getHttpServer()).get('/api/docs-json').expect(404);
    } finally {
      await app.close();
    }
  });
});

describe('Graceful shutdown (e2e)', () => {
  it('closes Prisma and Redis when the application closes', async () => {
    const app = await createTestApp();
    const prisma = app.get(PrismaService);
    const redis = app.get<Redis>(REDIS_CLIENT);
    const disconnect = jest.spyOn(prisma, '$disconnect');

    await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    await app.close();

    expect(disconnect).toHaveBeenCalled();
    expect(redis.status).toBe('end');
  });
});
