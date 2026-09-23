import type { JobRunner } from '../runner';

export function registerMarketDataHandlers(runner: JobRunner): void {
  runner.register('market_data.invalidate_caches', async ({ log }) => {
    log.info('market data cache invalidation placeholder (implemented in Wave 1)');
  });
  runner.register('market_data.expire_stale', async ({ log }) => {
    log.info('stale evidence sweep placeholder (implemented in Wave 1)');
  });
}
