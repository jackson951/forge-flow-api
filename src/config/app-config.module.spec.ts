import { Test } from '@nestjs/testing';

/**
 * Part 22 (found by running the setup guide from a clean clone): an empty variable such as
 * `PROVIDER_CONCURRENCY=` (as in .env.example) is "unset" after validation, but ConfigService
 * used to fall back to the raw process.env value '' and the worker refused to start.
 */
describe('AppConfigModule', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    jest.resetModules();
  });

  it('serves validated values only, never raw empty strings from process.env', async () => {
    process.env = {
      ...saved,
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      JWT_REFRESH_SECRET: 'b'.repeat(32),
      WORKER_CONCURRENCY: '5',
      PROVIDER_CONCURRENCY: '',
      DATABASE_CONNECTION_LIMIT: '',
      WORKER_HEARTBEAT_FILE: '',
    };
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { AppConfigModule } =
      require('./app-config.module') as typeof import('./app-config.module');
    const { AppConfigService } =
      require('./app-config.service') as typeof import('./app-config.service');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const moduleRef = await Test.createTestingModule({ imports: [AppConfigModule] }).compile();
    const config = moduleRef.get(AppConfigService);

    expect(config.queue.providerConcurrency).toBe(3);
    expect(config.get('DATABASE_CONNECTION_LIMIT')).toBeUndefined();
    expect(config.get('WORKER_HEARTBEAT_FILE')).toBeUndefined();
    expect(new URL(config.databaseUrl).searchParams.get('connection_limit')).toBe('10');
  });
});
