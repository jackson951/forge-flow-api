import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppConfigService } from '../../src/config/app-config.service';
import { uniqueEmail } from '../support/auth';
import { createTestApp } from '../support/create-app';

/** Rate limiting is disabled for the other suites; this one turns it back on (AC-03.10). */
class ThrottlingConfig extends AppConfigService {
  override get throttleEnabled(): boolean {
    return true;
  }
}

describe('Authentication rate limits (integration)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(AppConfigService).useClass(ThrottlingConfig),
    );
  });

  afterAll(() => app.close());

  const attempt = (email: string) =>
    request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'wrong password guess' });

  it('blocks the 6th login attempt for the same IP and email within a minute', async () => {
    const email = uniqueEmail('target');
    for (let i = 0; i < 5; i++) expect((await attempt(email)).status).toBe(401);

    const blocked = await attempt(email);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.body).toMatchObject({ statusCode: 429, error: 'Too Many Requests' });
  });

  it('counts per email, so one attacked account does not lock out others on the same IP', async () => {
    expect((await attempt(uniqueEmail('other'))).status).toBe(401);
  });

  it('limits registration to 5 per minute per IP', async () => {
    const register = () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'not-an-email', password: 'x', name: 'x' });
    for (let i = 0; i < 5; i++) expect((await register()).status).toBe(400);
    expect((await register()).status).toBe(429);
  });
});
