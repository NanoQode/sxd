import { and, eq, sql } from 'drizzle-orm';
import { appendOutbox, schema, type Transaction } from '@simplexd/db';
import type { OpsAlertPayload } from '@simplexd/notifications';
import { collectMonitoringMetrics } from './collect';
import {
  evaluateThresholds,
  resolveThresholds,
  THRESHOLDS_SETTING_KEY,
  type MonitoringMetrics,
  type MonitoringThresholds,
  type OpsAlert,
} from './thresholds';

/**
 * Raises operational alerts as `ops.alert` outbox events, at most once per
 * alert key per clock hour. The append-only audit log is the dedupe ledger:
 * each raised alert records `ops.alert_raised` for entity `ops_alert`
 * `<key>@<hour start>` (an indexed exact lookup), in the same transaction as
 * the outbox event, and a per-key advisory lock serialises concurrent
 * monitoring runs.
 */

const HOUR_MS = 3_600_000;

export function alertWindow(now: Date): string {
  return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS).toISOString();
}

export const alertEntityId = (key: string, window: string): string => `${key}@${window}`;

export async function raiseAlerts(
  tx: Transaction,
  alerts: OpsAlert[],
  options: { now?: Date; correlationId?: string | null } = {},
): Promise<{ raised: string[]; suppressed: string[] }> {
  const window = alertWindow(options.now ?? new Date());
  const raised: string[] = [];
  const suppressed: string[] = [];
  for (const alert of alerts) {
    const entityId = alertEntityId(alert.key, window);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ops_alert:${entityId}`}))`);
    const [existing] = await tx
      .select({ id: schema.auditEvents.id })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.entityType, 'ops_alert'),
          eq(schema.auditEvents.entityId, entityId),
        ),
      )
      .limit(1);
    if (existing) {
      suppressed.push(alert.key);
      continue;
    }
    const payload: OpsAlertPayload = { ...alert, window };
    await tx.insert(schema.auditEvents).values({
      actorType: 'system',
      action: 'ops.alert_raised',
      entityType: 'ops_alert',
      entityId,
      after: {
        key: alert.key,
        severity: alert.severity,
        value: alert.value,
        threshold: alert.threshold,
        roles: alert.roles,
      },
      reason: alert.title,
      correlationId: options.correlationId ?? null,
    });
    await appendOutbox(tx, {
      eventType: 'ops.alert',
      aggregateType: 'ops_alert',
      aggregateId: entityId,
      payload: { ...payload },
      correlationId: options.correlationId ?? null,
    });
    raised.push(alert.key);
  }
  return { raised, suppressed };
}

export async function loadThresholds(tx: Transaction): Promise<MonitoringThresholds> {
  const [row] = await tx
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, THRESHOLDS_SETTING_KEY));
  return resolveThresholds(row?.value);
}

export interface MonitoringSnapshot {
  metrics: MonitoringMetrics;
  alerts: OpsAlert[];
  raised: string[];
  suppressed: string[];
}

/** One monitoring run inside the caller's (system actor) transaction. */
export async function monitoringSnapshot(
  tx: Transaction,
  options: { now?: Date; correlationId?: string | null; thresholds?: MonitoringThresholds } = {},
): Promise<MonitoringSnapshot> {
  const thresholds = options.thresholds ?? (await loadThresholds(tx));
  const metrics = await collectMonitoringMetrics(tx, { now: options.now, thresholds });
  const alerts = evaluateThresholds(metrics, thresholds);
  const { raised, suppressed } = await raiseAlerts(tx, alerts, options);
  return { metrics, alerts, raised, suppressed };
}
