import { Inject, Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';
import { REDIS_CLIENT } from '../redis/redis.module';

/**
 * One atomic step per request: count the hit in a fixed window, and once the limit is
 * exceeded, block the key for `blockDuration`. Returns
 * [totalHits, windowMsLeft, blocked (0/1), blockMsLeft].
 */
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local windowLeft = redis.call('PTTL', KEYS[1])
local blockLeft = redis.call('PTTL', KEYS[2])
if blockLeft > 0 then return {hits, windowLeft, 1, blockLeft} end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return {hits, windowLeft, 1, tonumber(ARGV[3])}
end
return {hits, windowLeft, 0, 0}
`;

/**
 * Rate-limit counters in Redis, so limits hold across all API instances (Part 18, FR-18.1).
 * Same contract as the throttler's in-memory storage: ttl/blockDuration in ms in, times in
 * seconds out. Keys live under the deployment's prefix and expire on their own.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly prefix: string;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: AppConfigService,
  ) {
    this.prefix = `${config.get('QUEUE_PREFIX')}:throttle`;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `${this.prefix}:${throttlerName}:${key}`;
    const [hits, windowLeft, blocked, blockLeft] = (await this.redis.eval(
      INCREMENT_SCRIPT,
      2,
      `${base}:hits`,
      `${base}:block`,
      String(ttl),
      String(limit),
      String(blockDuration || ttl),
    )) as [number, number, number, number];
    return {
      totalHits: hits,
      timeToExpire: Math.max(0, Math.ceil(windowLeft / 1000)),
      isBlocked: blocked === 1,
      timeToBlockExpire: Math.max(0, Math.ceil(blockLeft / 1000)),
    };
  }
}
