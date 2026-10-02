import { AppConfigService } from '../../config/app-config.service';
import { RedisThrottlerStorage } from './redis-throttler.storage';

const config = { get: () => 'ff-unit' } as unknown as AppConfigService;

describe('RedisThrottlerStorage', () => {
  it('maps the script result to the throttler record (ms in, seconds out)', async () => {
    const redis = { eval: jest.fn(async () => [6, 42_100, 1, 60_000]) };
    const storage = new RedisThrottlerStorage(redis as never, config);
    await expect(storage.increment('k', 60_000, 5, 0, 'default')).resolves.toEqual({
      totalHits: 6,
      timeToExpire: 43,
      isBlocked: true,
      timeToBlockExpire: 60,
    });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      2,
      'ff-unit:throttle:default:k:hits',
      'ff-unit:throttle:default:k:block',
      '60000',
      '5',
      '60000', // block duration defaults to the window
    );
  });

  it('fails open when Redis is unavailable, warning at most every 30 s', async () => {
    const redis = {
      eval: jest.fn(async () => {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      }),
    };
    const storage = new RedisThrottlerStorage(redis as never, config);
    const warn = jest
      .spyOn((storage as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation();
    for (let i = 0; i < 3; i++) {
      await expect(storage.increment('k', 60_000, 5, 0, 'default')).resolves.toEqual({
        totalHits: 0,
        timeToExpire: 60,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
