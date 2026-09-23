import { and, eq, isNull, lt, lte, sql } from 'drizzle-orm';
import { schema, systemContext, withActor } from '@simplexd/db';
import { monitoringSnapshot } from '../monitoring/alerts';
import type { JobRunner } from '../runner';

/**
 * Scheduled housekeeping. Every handler is idempotent and safe to re-run.
 */
export function registerMaintenanceHandlers(runner: JobRunner): void {
  runner.register('bookings.expire_holds', async ({ db, log }) => {
    const removed = await withActor(db, systemContext(), (tx) =>
      tx
        .delete(schema.slotReservations)
        .where(
          and(
            eq(schema.slotReservations.kind, 'hold'),
            lt(schema.slotReservations.expiresAt, new Date()),
          ),
        )
        .returning({ id: schema.slotReservations.id }),
    );
    if (removed.length > 0) log.info({ removed: removed.length }, 'expired booking holds released');
  });

  runner.register('invoices.mark_overdue', async ({ db, log }) => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await withActor(db, systemContext(), (tx) =>
      tx
        .update(schema.invoices)
        .set({ status: 'overdue' })
        .where(
          and(
            sql`${schema.invoices.status} in ('issued','partially_paid')`,
            lt(schema.invoices.dueDate, today),
          ),
        )
        .returning({ id: schema.invoices.id }),
    );
    if (rows.length > 0) log.info({ count: rows.length }, 'invoices marked overdue');
  });

  runner.register('tenders.close_due', async ({ db, log }) => {
    const now = new Date();
    const rows = await withActor(db, systemContext(), (tx) =>
      tx
        .update(schema.tenders)
        .set({ status: 'closed', closedAt: now })
        .where(
          and(
            sql`${schema.tenders.status} in ('published','clarifications')`,
            lte(schema.tenders.submissionDeadlineAt, now),
          ),
        )
        .returning({ id: schema.tenders.id }),
    );
    if (rows.length > 0) log.info({ count: rows.length }, 'tenders closed at deadline');
  });

  runner.register('files.purge_expired', async ({ db, log }) => {
    const rows = await withActor(db, systemContext(), (tx) =>
      tx
        .update(schema.fileObjects)
        .set({ status: 'deleted', deletedAt: new Date() })
        .where(
          and(
            lt(schema.fileObjects.retentionUntil, new Date()),
            isNull(schema.fileObjects.deletedAt),
            sql`${schema.fileObjects.status} in ('pending_upload','rejected','infected','scan_failed')`,
          ),
        )
        .returning({ id: schema.fileObjects.id }),
    );
    if (rows.length > 0)
      log.info({ count: rows.length }, 'expired quarantined files marked deleted');
  });

  runner.register('maintenance.purge_expired_keys', async ({ db, log }) => {
    const now = new Date();
    const [keys, buckets] = await withActor(db, systemContext(), async (tx) => {
      const removedKeys = await tx
        .delete(schema.idempotencyKeys)
        .where(lt(schema.idempotencyKeys.expiresAt, now))
        .returning({ key: schema.idempotencyKeys.key });
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
      const removedBuckets = await tx
        .delete(schema.rateLimitBuckets)
        .where(lt(schema.rateLimitBuckets.windowStart, dayAgo))
        .returning({ key: schema.rateLimitBuckets.key });
      return [removedKeys.length, removedBuckets.length];
    });
    if (keys > 0 || buckets > 0) log.info({ keys, buckets }, 'expired idempotency keys purged');
  });

  runner.register('monitoring.snapshot', async ({ db, log, job }) => {
    // Jobs, outbox and provider logs are privileged-only under row-level security, so
    // read as the system actor. Crossed thresholds raise `ops.alert` (see ../monitoring).
    const snapshot = await withActor(db, systemContext(job.correlationId ?? 'monitoring'), (tx) =>
      monitoringSnapshot(tx, { correlationId: job.correlationId }),
    );
    log.info(
      {
        metrics: snapshot.metrics,
        alerts: snapshot.alerts.map((a) => a.key),
        suppressed: snapshot.suppressed,
      },
      'queue snapshot',
    );
    if (snapshot.raised.length > 0)
      log.warn({ raised: snapshot.raised }, 'operational alerts raised');
  });
}
