import { Response } from 'express';
import { HealthController } from './health.controller';
import { HealthService, ReadinessReport } from './health.service';

const report = (status: ReadinessReport['status']): ReadinessReport => ({
  status,
  checks: {
    database: { status: status === 'ok' ? 'up' : 'down', latencyMs: 1 },
    redis: { status: 'up', latencyMs: 1 },
  },
});

describe('HealthController', () => {
  const readiness = jest.fn<Promise<ReadinessReport>, []>();
  const controller = new HealthController({ readiness } as unknown as HealthService);
  const res = { status: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  it('reports liveness without checking dependencies', () => {
    expect(controller.live().status).toBe('ok');
    expect(readiness).not.toHaveBeenCalled();
  });

  it('keeps 200 when ready', async () => {
    readiness.mockResolvedValue(report('ok'));
    await expect(controller.ready(res as unknown as Response)).resolves.toEqual(report('ok'));
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 503 when not ready', async () => {
    readiness.mockResolvedValue(report('error'));
    await controller.ready(res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
