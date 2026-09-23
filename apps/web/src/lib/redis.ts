import 'server-only';
import Redis from 'ioredis';
import { logger } from './logger';

const globalRef = globalThis as unknown as { __sxRedis?: Redis | null };

/** Shared Redis client, or null when REDIS_URL is unset (single-node fallbacks apply). */
export function getRedis(): Redis | null {
  if (globalRef.__sxRedis !== undefined) return globalRef.__sxRedis;
  const url = process.env.REDIS_URL;
  if (!url) {
    globalRef.__sxRedis = null;
    return null;
  }
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 3000,
  });
  client.on('error', (err) => logger().warn({ err: err.message }, 'redis error'));
  client.connect().catch((err) => logger().warn({ err: err.message }, 'redis connect failed; using in-process fallbacks'));
  globalRef.__sxRedis = client;
  return client;
}
