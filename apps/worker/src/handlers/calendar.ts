import type { JobRunner } from '../runner';

export function registerCalendarHandlers(runner: JobRunner): void {
  for (const kind of [
    'calendar.sync_appointment',
    'calendar.cancel_appointment',
    'calendar.renew_watch_channels',
    'calendar.reconcile_pending_conferences',
  ]) {
    runner.register(kind, async ({ log }) => {
      log.info({ kind }, 'calendar handler placeholder (implemented in Wave 3)');
    });
  }
}
