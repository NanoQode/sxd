import { Redis } from 'ioredis';
import type { Logger } from 'pino';

/**
 * Worker-side Redis client, or null when REDIS_URL is unset. The web app
 * keeps its public read-model cache in Redis under `cache:<key>` (see
 * apps/web/src/lib/cache.ts); the worker only ever deletes those keys.
 */

let client: Redis | null | undefined;

export function getRedis(log?: Pick<Logger, 'warn'>): Redis | null {
  if (client !== undefined) return client;
  const url = process.env.REDIS_URL;
  if (!url) {
    client = null;
    return client;
  }
  client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 3000,
  });
  client.on('error', (err: Error) => log?.warn({ err: err.message }, 'redis error'));
  return client;
}

/** Connects a lazy client once; commands fail fast without an offline queue. */
export async function ensureConnected(redis: Redis): Promise<void> {
  if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
}

export async function closeRedis(): Promise<void> {
  const current = client;
  client = undefined;
  if (current) await current.quit().catch(() => current.disconnect());
}
