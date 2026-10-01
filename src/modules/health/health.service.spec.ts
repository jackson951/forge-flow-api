import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { EventEmitter } from 'node:events';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DEPENDENCY_CHECK_TIMEOUT_MS, HealthService } from './health.service';

function createService(db: () => Promise<unknown>, redis: () => Promise<unknown>) {
  const prisma = { $queryRaw: jest.fn(db) } as unknown as PrismaService;
  const client = { ping: jest.fn(redis) } as unknown as Redis;
  return new HealthService(prisma, client);
}

const ok = () => Promise.resolve('ok');
const fail = () => Promise.reject(new Error('ECONNREFUSED'));
const hang = () => new Promise(() => undefined);

describe('HealthService.readiness', () => {
  beforeAll(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterAll(() => jest.restoreAllMocks());

  it('is ok when both dependencies respond', async () => {
    const report = await createService(ok, ok).readiness();
    expect(report.status).toBe('ok');
    expect(report.checks.database.status).toBe('up');
    expect(report.checks.redis.status).toBe('up');
  });

  it('reports the database as down', async () => {
    const report = await createService(fail, ok).readiness();
    expect(report.status).toBe('error');
    expect(report.checks.database.status).toBe('down');
    expect(report.checks.redis.status).toBe('up');
  });

  it('reports redis as down', async () => {
    const report = await createService(ok, fail).readiness();
    expect(report.status).toBe('error');
    expect(report.checks.redis.status).toBe('down');
  });

  it('times out a hanging dependency instead of hanging the probe', async () => {
    jest.useFakeTimers();
    try {
      const pending = createService(ok, hang).readiness();
      await jest.advanceTimersByTimeAsync(DEPENDENCY_CHECK_TIMEOUT_MS);
      const report = await pending;
      expect(report.status).toBe('error');
      expect(report.checks.redis.status).toBe('down');
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits for a connecting Redis client instead of reporting it down', async () => {
    const client = Object.assign(new EventEmitter(), {
      status: 'connecting',
      ping: jest.fn(() => Promise.resolve('PONG')),
    });
    const prisma = { $queryRaw: jest.fn(ok) } as unknown as PrismaService;
    const pending = new HealthService(prisma, client as unknown as Redis).readiness();
    setTimeout(() => {
      client.status = 'ready';
      client.emit('ready');
    }, 50);

    const report = await pending;
    expect(report.checks.redis.status).toBe('up');
    expect(client.listenerCount('ready')).toBe(0);
  });
});
