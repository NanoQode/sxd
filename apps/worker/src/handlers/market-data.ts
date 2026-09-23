import { invalidateMarketCaches, redisKeyStore } from '../market-data/cache';
import {
  openRefreshTask,
  REFRESH_TASK_JOB,
  sweepStaleEvidence,
  type RefreshTaskPayload,
} from '../market-data/stale-evidence';
import { ensureConnected, getRedis } from '../redis';
import { NonRetryableJobError, type JobRunner } from '../runner';

/**
 * Market data jobs:
 * - `market_data.invalidate_caches` (outbox `market_data.published`): deletes
 *   the web app's public market cache keys in Redis as a durable backstop to
 *   the synchronous invalidation after publishing (see ../market-data/cache.ts).
 * - `market_data.expire_stale` (scheduled): applies the freshness policies to
 *   published evidence and queues one research task per stale observation per
 *   period (see ../market-data/stale-evidence.ts). Published data is unchanged.
 * - `market_data.open_refresh_task`: opens that research task after re-checking.
 */
export function registerMarketDataHandlers(runner: JobRunner): void {
  runner.register('market_data.invalidate_caches', async ({ log }) => {
    const redis = getRedis(log);
    if (!redis) {
      log.debug('REDIS_URL is not set; web processes expire their in-process cache within 60 s');
      return;
    }
    await ensureConnected(redis);
    const deleted = await invalidateMarketCaches(redisKeyStore(redis));
    log.info({ deleted }, 'market read-model cache invalidated');
  });

  runner.register('market_data.expire_stale', async ({ db, log, job }) => {
    const summary = await sweepStaleEvidence(db, { correlationId: job.correlationId ?? undefined });
    if (summary.stale > 0) log.info(summary, 'stale evidence sweep');
  });

  runner.register(REFRESH_TASK_JOB, async ({ db, log, job }) => {
    const payload = job.payload as Partial<RefreshTaskPayload>;
    if (!payload.observationId || !payload.marketId || !payload.staleSince || !payload.dataType)
      throw new NonRetryableJobError('refresh task payload is incomplete');
    const result = await openRefreshTask(db, payload as RefreshTaskPayload, {
      correlationId: job.correlationId,
    });
    log.info({ observationId: payload.observationId, ...result }, 'stale evidence research task');
  });
}
