import 'server-only';
import { createHash } from 'node:crypto';
import { ApiError } from '@simplexd/contracts';
import { getRedis } from './redis';

/**
 * Fixed-window rate limiter keyed by an identifier (IP hash, user id, route).
 * Uses Redis when available and an in-process map otherwise (single-node
 * fallback; multi-node deployments should always configure REDIS_URL).
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const memory = new Map<string, Bucket>();

export interface RateLimitOptions {
  /** Window length in seconds. */
  windowSeconds: number;
  /** Maximum requests per window. */
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function hashIp(ip: string | null | undefined): string {
  return createHash('sha256')
    .update(ip ?? 'unknown')
    .digest('hex')
    .slice(0, 24);
}

export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? null;
  return req.headers.get('x-real-ip');
}

export async function rateLimit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
  const redis = getRedis();
  const now = Date.now();
  const window = Math.floor(now / (options.windowSeconds * 1000));
  const bucketKey = `rl:${key}:${window}`;
  if (redis) {
    try {
      const count = await redis.incr(bucketKey);
      if (count === 1) await redis.expire(bucketKey, options.windowSeconds + 1);
      const resetAt = (window + 1) * options.windowSeconds * 1000;
      return {
        allowed: count <= options.max,
        remaining: Math.max(0, options.max - count),
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      };
    } catch {
      // fall through to memory
    }
  }
  const existing = memory.get(bucketKey);
  const resetAt = (window + 1) * options.windowSeconds * 1000;
  const bucket = existing ?? { count: 0, resetAt };
  bucket.count += 1;
  memory.set(bucketKey, bucket);
  if (memory.size > 10_000) {
    for (const [k, v] of memory) if (v.resetAt < now) memory.delete(k);
  }
  return {
    allowed: bucket.count <= options.max,
    remaining: Math.max(0, options.max - bucket.count),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
  };
}

/** Throws a 429 ApiError when the limit is exceeded. */
export async function enforceRateLimit(key: string, options: RateLimitOptions): Promise<void> {
  const result = await rateLimit(key, options);
  if (!result.allowed) {
    throw new ApiError('rate_limited', 'too many requests; please try again shortly', {
      retryAfterSeconds: result.retryAfterSeconds,
      retryable: true,
    });
  }
}
