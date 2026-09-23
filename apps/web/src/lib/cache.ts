import 'server-only';
import { getRedis } from './redis';

/**
 * Small cache for public, non-personal data (market GeoJSON, published
 * content). Private responses are never cached here. Keys carry a version
 * that publishing bumps, so stale entries cannot outlive a publication.
 */

interface Entry {
  value: string;
  expiresAt: number;
}

const memory = new Map<string, Entry>();

export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get(`cache:${key}`);
      if (raw) return JSON.parse(raw) as T;
    } catch {
      /* fall back */
    }
  }
  const hit = memory.get(key);
  if (hit && hit.expiresAt > Date.now()) return JSON.parse(hit.value) as T;
  return null;
}

export async function cacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  const raw = JSON.stringify(value);
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(`cache:${key}`, raw, 'EX', ttlSeconds);
      return;
    } catch {
      /* fall back */
    }
  }
  memory.set(key, { value: raw, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export async function cacheDelete(prefix: string): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      const keys = await redis.keys(`cache:${prefix}*`);
      if (keys.length > 0) await redis.del(...keys);
    } catch {
      /* fall back */
    }
  }
  for (const k of memory.keys()) if (k.startsWith(prefix)) memory.delete(k);
}

export async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;
  const value = await load();
  await cacheSet(key, value, ttlSeconds);
  return value;
}
