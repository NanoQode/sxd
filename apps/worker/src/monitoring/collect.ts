import { sql } from 'drizzle-orm';
import { OUTBOX_MAX_ATTEMPTS, queueDepth, type Transaction } from '@simplexd/db';
import type { MonitoringMetrics, MonitoringThresholds } from './thresholds';

/**
 * Reads the operational metrics the thresholds are evaluated against. Runs
 * under the system actor (jobs, outbox, provider events and integration logs
 * are privileged-only under row-level security). Only counts leave here.
 */

const HOUR_MS = 3_600_000;

async function count(tx: Transaction, query: ReturnType<typeof sql>): Promise<number> {
  const res = await tx.execute<{ n: string | number }>(query);
  return Number(res.rows[0]?.n ?? 0);
}

export async function collectMonitoringMetrics(
  tx: Transaction,
  options: {
    now?: Date;
    thresholds: Pick<MonitoringThresholds, 'scanStuckMinutes' | 'reportReviewOverdueHours'>;
  },
): Promise<MonitoringMetrics> {
  const now = options.now ?? new Date();
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const scanCutoff = new Date(now.getTime() - options.thresholds.scanStuckMinutes * 60_000);
  const reviewCutoff = new Date(
    now.getTime() - options.thresholds.reportReviewOverdueHours * HOUR_MS,
  );

  const depth = await queueDepth(tx);

  const stuck = await count(
    tx,
    sql`select count(*) as n from outbox_events where published_at is null and attempts >= ${OUTBOX_MAX_ATTEMPTS}`,
  );
  const oldestOutbox = await tx.execute<{ created_at: Date | string | null }>(
    sql`select min(created_at) as created_at from outbox_events where published_at is null and attempts < ${OUTBOX_MAX_ATTEMPTS}`,
  );
  const oldestCreated = oldestOutbox.rows[0]?.created_at ?? null;

  const paymentFailuresLastHour = await count(
    tx,
    sql`select count(*) as n from provider_events
        where received_at >= ${hourAgo} and (signature_valid = false or processing_status = 'failed')`,
  );
  const smsRejectedLastHour = await count(
    tx,
    sql`select count(*) as n from integration_logs
        where provider = 'termii' and event = 'webhook.rejected' and created_at >= ${hourAgo}`,
  );

  const failedSyncs = await count(
    tx,
    sql`select count(*) as n from event_syncs s join appointments a on a.id = s.appointment_id
        where s.status in ('failed', 'conflict') and a.ends_at >= ${now}`,
  );
  const unhealthyConnections = await count(
    tx,
    sql`select count(*) as n from calendar_connections where status in ('degraded', 'expired')`,
  );

  const scanFailuresLastHour = await count(
    tx,
    sql`select count(*) as n from file_objects
        where status = 'scan_failed' and deleted_at is null and updated_at >= ${hourAgo}`,
  );
  const stuckScanning = await count(
    tx,
    sql`select count(*) as n from file_objects
        where status in ('uploaded', 'scanning') and deleted_at is null and updated_at < ${scanCutoff}`,
  );
  const unhealthy = await tx.execute<{ provider: string }>(
    sql`select distinct provider from integration_configs
        where provider in ('storage', 'scanner') and is_active and status in ('degraded', 'expired')
        order by provider`,
  );

  // The hourly integrations.health_check records the Termii wallet balance; development
  // adapters report a simulated balance, so only live (non-dev) configurations count.
  const balance = await tx.execute<{ balance: string | null; created_at: Date | string }>(
    sql`select l.metadata_sanitized->'details'->>'balance' as balance, l.created_at
        from integration_logs l
        where l.provider = 'termii' and l.event = 'health.check'
          and exists (select 1 from integration_configs c
                      where c.provider = 'termii' and c.is_active and c.adapter <> 'dev'
                        and c.environment::text = l.environment)
        order by l.created_at desc limit 1`,
  );
  const balanceRow = balance.rows[0];
  const balanceValue = balanceRow?.balance == null ? null : Number(balanceRow.balance);

  const overdueReportReviews = await count(
    tx,
    sql`select count(*) as n from reports where status = 'in_review' and updated_at < ${reviewCutoff}`,
  );
  const overdueServiceRequests = await count(
    tx,
    sql`select count(*) as n from service_requests
        where sla_due_at < ${now}
          and status not in ('delivered', 'completed', 'rejected', 'cancelled', 'paused')`,
  );
  const overdueWorkOrders = await count(
    tx,
    sql`select count(*) as n from work_orders
        where sla_due_at < ${now}
          and status not in ('completed', 'verified', 'closed', 'rejected', 'cancelled')`,
  );

  const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
  return {
    jobs: {
      pending: depth.pending,
      running: depth.running,
      dead: depth.dead,
      oldestPendingSeconds: depth.oldestPendingSeconds,
    },
    outbox: {
      unpublished: depth.outboxUnpublished,
      stuck,
      oldestUnpublishedSeconds: oldestCreated
        ? Math.max(0, Math.round((now.getTime() - toDate(oldestCreated).getTime()) / 1000))
        : null,
    },
    webhooks: { paymentFailuresLastHour, smsRejectedLastHour },
    calendar: { failedSyncs, unhealthyConnections },
    storage: {
      scanFailuresLastHour,
      stuckScanning,
      unhealthyProviders: unhealthy.rows.map((r) => r.provider),
    },
    sms: {
      balance: balanceValue !== null && Number.isFinite(balanceValue) ? balanceValue : null,
      checkedAt: balanceRow ? toDate(balanceRow.created_at).toISOString() : null,
    },
    reviews: { overdueReportReviews },
    sla: { overdueServiceRequests, overdueWorkOrders },
  };
}
