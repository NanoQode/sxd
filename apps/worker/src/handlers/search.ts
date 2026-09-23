import { SAVED_SEARCH_ALERT_JOB, runSavedSearchAlerts } from '@simplexd/notifications';
import type { JobRunner } from '../runner';

/**
 * Property search jobs. `search.saved_search_alerts` (scheduled) finds newly
 * published listings matching each alert-enabled saved search and enqueues
 * one notification per saved search × listing. The job body lives in
 * @simplexd/notifications (`runSavedSearchAlerts`) and is shared with the web
 * integration tests, so the worker and the tests run the same code; its
 * idempotency ledger is the notification job's dedupe key, so overlapping or
 * repeated runs never alert twice.
 */
export function registerSearchHandlers(runner: JobRunner): void {
  runner.register(SAVED_SEARCH_ALERT_JOB, async ({ db, log }) => {
    const result = await runSavedSearchAlerts(db, {
      log: {
        info: (obj, msg) => log.info(obj, msg),
        warn: (obj, msg) => log.warn(obj, msg),
        error: (obj, msg) => log.error(obj, msg),
      },
    });
    if (result.alerted > 0 || result.searches > 0) log.info(result, 'saved search alerts');
  });
}
