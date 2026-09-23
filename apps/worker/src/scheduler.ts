import type { Logger } from 'pino';
import { enqueueJob, reapStaleJobs, systemContext, withActor, type Database } from '@simplexd/db';

/**
 * Periodic maintenance. Each schedule enqueues an idempotent job keyed by the
 * time bucket, so several worker instances never duplicate a run.
 */
interface Schedule {
  type: string;
  queue: string;
  everyMs: number;
}

const schedules: Schedule[] = [
  { type: 'payments.reconcile_pending', queue: 'payments', everyMs: 5 * 60_000 },
  { type: 'notifications.send_due_reminders', queue: 'notifications', everyMs: 60_000 },
  { type: 'notifications.send_digests', queue: 'notifications', everyMs: 15 * 60_000 },
  { type: 'calendar.renew_watch_channels', queue: 'calendar', everyMs: 60 * 60_000 },
  { type: 'calendar.reconcile_pending_conferences', queue: 'calendar', everyMs: 2 * 60_000 },
  { type: 'bookings.expire_holds', queue: 'default', everyMs: 60_000 },
  { type: 'appointments.scan_reminders', queue: 'calendar', everyMs: 5 * 60_000 },
  { type: 'invoices.mark_overdue', queue: 'default', everyMs: 60 * 60_000 },
  { type: 'tenders.close_due', queue: 'default', everyMs: 60_000 },
  { type: 'market_data.expire_stale', queue: 'default', everyMs: 6 * 60 * 60_000 },
  { type: 'files.purge_expired', queue: 'media', everyMs: 60 * 60_000 },
  { type: 'monitoring.snapshot', queue: 'default', everyMs: 5 * 60_000 },
  { type: 'maintenance.purge_expired_keys', queue: 'default', everyMs: 30 * 60_000 },
  { type: 'integrations.health_check', queue: 'default', everyMs: 60 * 60_000 },
];

export function startScheduler(opts: { db: Database; log: Logger }): () => void {
  const timers: NodeJS.Timeout[] = [];
  for (const sched of schedules) {
    const run = async () => {
      const bucket = Math.floor(Date.now() / sched.everyMs);
      try {
        await withActor(opts.db, systemContext('scheduler'), (tx) =>
          enqueueJob(tx, {
            type: sched.type,
            queue: sched.queue,
            payload: { bucket },
            dedupeKey: `sched:${sched.type}:${bucket}`,
            maxAttempts: 3,
          }),
        );
      } catch (err) {
        opts.log.error({ err, type: sched.type }, 'failed to enqueue scheduled job');
      }
    };
    void run();
    timers.push(setInterval(() => void run(), sched.everyMs));
  }
  timers.push(
    setInterval(() => {
      withActor(opts.db, systemContext('reaper'), (tx) => reapStaleJobs(tx, 15 * 60_000))
        .then((n) => {
          if (n > 0) opts.log.warn({ released: n }, 'released stale job locks');
        })
        .catch((err) => opts.log.error({ err }, 'stale lock reaper failed'));
    }, 60_000),
  );
  return () => timers.forEach((t) => clearInterval(t));
}
