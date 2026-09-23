import type { Redis } from 'ioredis';

/**
 * Durable backstop for the public market read-model cache. Publishing code in
 * the web app deletes `cache:markets*` right after its transaction commits
 * (apps/web/src/lib/cache.ts → `cacheDelete('markets')`), but that call is
 * best effort: a Redis blip or a crash between commit and delete would leave
 * a stale GeoJSON cached until its TTL. The `market_data.published` outbox
 * event is committed with the change, so this job repeats the deletion
 * reliably (with retries). Only Redis is reachable from the worker; a web
 * process without Redis keeps an in-process copy for at most its TTL (60 s).
 */

/** Same prefix the web app writes (`cache:` + key) and deletes (`cacheDelete('markets')`). */
export const MARKET_CACHE_PATTERN = 'cache:markets*';

export interface CacheKeyStore {
  /** One SCAN step: returns the next cursor ("0" when done) and the matching keys. */
  scan(cursor: string, pattern: string, count: number): Promise<[string, string[]]>;
  del(keys: string[]): Promise<number>;
}

export function redisKeyStore(redis: Redis): CacheKeyStore {
  return {
    scan: (cursor, pattern, count) => redis.scan(cursor, 'MATCH', pattern, 'COUNT', count),
    del: (keys) => redis.del(...keys),
  };
}

/** Deletes every key matching `pattern` using SCAN (never KEYS, which blocks Redis). */
export async function deleteKeysMatching(
  store: CacheKeyStore,
  pattern: string,
  batch = 200,
): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await store.scan(cursor, pattern, batch);
    if (keys.length > 0) deleted += await store.del(keys);
    cursor = next;
  } while (cursor !== '0');
  return deleted;
}

export function invalidateMarketCaches(store: CacheKeyStore): Promise<number> {
  return deleteKeysMatching(store, MARKET_CACHE_PATTERN);
}
