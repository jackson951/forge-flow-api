import Redis from 'ioredis';
import { loadDotEnv } from './support/test-database';

/** Deletes the BullMQ keys test files created under their unique `ff-test-*` prefixes. */
export default async function globalTeardown(): Promise<void> {
  loadDotEnv();
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'ff-test-*', 'COUNT', 500);
      if (keys.length) await redis.unlink(...keys);
      cursor = next;
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }
}
