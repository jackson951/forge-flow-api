import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';
import { QueueBackpressure, QueueBusyException } from './queue-backpressure.service';
import { RunQueue } from './run-queue.service';

function setup(waiting: () => Promise<number>, threshold = 10) {
  const getWaitingCount = jest.fn(waiting);
  const warn = jest.fn();
  const logger = { setContext: jest.fn(), warn } as unknown as PinoLogger;
  const config = { queue: { backpressureThreshold: threshold } } as AppConfigService;
  const queue = { queue: { getWaitingCount } } as unknown as RunQueue;
  return { service: new QueueBackpressure(queue, config, logger), getWaitingCount, warn };
}

describe('QueueBackpressure', () => {
  afterEach(() => jest.useRealTimers());

  it('accepts manual runs up to the threshold and refuses them above it with 429', async () => {
    let waiting = 10;
    const { service, warn } = setup(async () => waiting);
    await expect(service.assertAcceptingManualRuns()).resolves.toBeUndefined();

    jest.useFakeTimers({ now: Date.now() + 2_000 });
    waiting = 11;
    const err = await service.assertAcceptingManualRuns().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueueBusyException);
    expect((err as QueueBusyException).getStatus()).toBe(429);
    expect((err as QueueBusyException).retryAfterSeconds).toBe(30);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ alert: 'queue_backpressure', waiting: 11, threshold: 10 }),
      expect.any(String),
    );
  });

  it('webhook intake is never refused, only alerted, at most once per 30 s', async () => {
    const { service, warn } = setup(async () => 50);
    jest.useFakeTimers({ now: 1_000_000 });
    await expect(service.observe()).resolves.toBeUndefined();
    jest.setSystemTime(1_005_000);
    await service.observe();
    expect(warn).toHaveBeenCalledTimes(1);
    jest.setSystemTime(1_031_000);
    await service.observe();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'webhook' }),
      expect.any(String),
    );
  });

  it('reads the queue depth at most once per second', async () => {
    const { service, getWaitingCount } = setup(async () => 0);
    jest.useFakeTimers({ now: 1_000_000 });
    for (let i = 0; i < 5; i++) await service.assertAcceptingManualRuns();
    expect(getWaitingCount).toHaveBeenCalledTimes(1);
    jest.setSystemTime(1_001_500);
    await service.assertAcceptingManualRuns();
    expect(getWaitingCount).toHaveBeenCalledTimes(2);
  });

  it('fails open when Redis errors or hangs', async () => {
    const failing = setup(() => Promise.reject(new Error('connection refused')));
    await expect(failing.service.assertAcceptingManualRuns()).resolves.toBeUndefined();
    expect(failing.warn).toHaveBeenCalledWith(
      { error: 'connection refused' },
      'Could not read queue depth',
    );

    jest.useFakeTimers();
    const hanging = setup(() => new Promise<number>(() => undefined));
    const pending = hanging.service.assertAcceptingManualRuns();
    await jest.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBeUndefined();
  });

  it('a threshold of 0 disables it without asking Redis', async () => {
    const { service, getWaitingCount } = setup(async () => 1_000_000, 0);
    await expect(service.assertAcceptingManualRuns()).resolves.toBeUndefined();
    expect(getWaitingCount).not.toHaveBeenCalled();
  });
});
