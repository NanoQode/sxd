import type { OpsAlertPayload } from '@simplexd/notifications';

/**
 * Operational alert thresholds (brief §19: queue lag, webhook failures,
 * failed syncs, storage errors, low provider balance, overdue reviews).
 *
 * Defaults are the constants below. An operator can override any of them
 * without a deploy by storing a partial JSON object in the `settings` row
 * `monitoring.thresholds`, e.g.
 *   {"queueLagSeconds": 900, "smsBalanceMinimum": 10000, "deadJobs": null}
 * A `null` value switches that check off; unknown keys and invalid values are
 * ignored. docs/operations/deployment.md lists every threshold.
 */
export interface MonitoringThresholds {
  /** Oldest due, unclaimed job has waited at least this long (seconds). */
  queueLagSeconds: number | null;
  /** Jobs in the dead-letter state (retry them from Admin → Jobs & Outbox). */
  deadJobs: number | null;
  /** Outbox events that failed routing OUTBOX_MAX_ATTEMPTS times and are no longer relayed. */
  stuckOutboxEvents: number | null;
  /** Oldest relayable, unpublished outbox event is at least this old (seconds): relay not running. */
  outboxLagSeconds: number | null;
  /** Payment webhooks with an invalid signature or failed processing in the last hour. */
  paymentWebhookFailuresPerHour: number | null;
  /** Termii webhooks rejected (signature/format) in the last hour. */
  smsWebhookRejectionsPerHour: number | null;
  /** Failed/conflicting calendar event syncs for upcoming appointments plus degraded connections. */
  calendarSyncFailures: number | null;
  /** Scan failures in the last hour + uploads stuck before scanning + degraded storage/scanner. */
  storageErrors: number | null;
  /** Minutes after which an uploaded file still waiting for its scan counts as a storage error. */
  scanStuckMinutes: number;
  /** Alert when the last Termii balance seen by the hourly health check is below this amount. */
  smsBalanceMinimum: number | null;
  /** Reports waiting in review longer than `reportReviewOverdueHours`. */
  overdueReportReviews: number | null;
  reportReviewOverdueHours: number;
  /** Open service requests and work orders past their SLA due time. */
  overdueSlaItems: number | null;
}

export const DEFAULT_THRESHOLDS: Readonly<MonitoringThresholds> = Object.freeze({
  queueLagSeconds: 600,
  deadJobs: 1,
  stuckOutboxEvents: 1,
  outboxLagSeconds: 600,
  paymentWebhookFailuresPerHour: 5,
  smsWebhookRejectionsPerHour: 5,
  calendarSyncFailures: 1,
  storageErrors: 1,
  scanStuckMinutes: 30,
  smsBalanceMinimum: 5000,
  overdueReportReviews: 1,
  reportReviewOverdueHours: 48,
  overdueSlaItems: 1,
});

export const THRESHOLDS_SETTING_KEY = 'monitoring.thresholds';

const WINDOW_KEYS = new Set<keyof MonitoringThresholds>([
  'scanStuckMinutes',
  'reportReviewOverdueHours',
]);

/** Merges a stored override onto the defaults, ignoring anything that is not a valid value. */
export function resolveThresholds(override: unknown): MonitoringThresholds {
  const out: MonitoringThresholds = { ...DEFAULT_THRESHOLDS };
  if (!override || typeof override !== 'object' || Array.isArray(override)) return out;
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (!(key in DEFAULT_THRESHOLDS)) continue;
    const k = key as keyof MonitoringThresholds;
    if (value === null && !WINDOW_KEYS.has(k)) {
      (out as unknown as Record<string, number | null>)[k] = null;
    } else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      if (WINDOW_KEYS.has(k) && value === 0) continue;
      (out as unknown as Record<string, number | null>)[k] = value;
    }
  }
  return out;
}

export interface MonitoringMetrics {
  jobs: { pending: number; running: number; dead: number; oldestPendingSeconds: number | null };
  outbox: { unpublished: number; stuck: number; oldestUnpublishedSeconds: number | null };
  webhooks: { paymentFailuresLastHour: number; smsRejectedLastHour: number };
  calendar: { failedSyncs: number; unhealthyConnections: number };
  storage: { scanFailuresLastHour: number; stuckScanning: number; unhealthyProviders: string[] };
  sms: { balance: number | null; checkedAt: string | null };
  reviews: { overdueReportReviews: number };
  sla: { overdueServiceRequests: number; overdueWorkOrders: number };
}

export type OpsAlert = Omit<OpsAlertPayload, 'window'>;

function duration(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * Pure threshold evaluation: which alerts the current metrics raise. A check
 * whose threshold is null is off. Messages carry counts and thresholds only.
 */
export function evaluateThresholds(m: MonitoringMetrics, t: MonitoringThresholds): OpsAlert[] {
  const alerts: OpsAlert[] = [];
  const reached = (value: number, threshold: number | null): threshold is number =>
    threshold !== null && value >= threshold;

  const lag = m.jobs.oldestPendingSeconds;
  if (lag !== null && reached(lag, t.queueLagSeconds)) {
    alerts.push({
      key: 'queue.lag',
      severity: lag >= t.queueLagSeconds * 3 ? 'critical' : 'warning',
      title: 'Job queue is falling behind',
      message: `The oldest due job has waited ${duration(lag)} (threshold ${duration(t.queueLagSeconds)}); ${m.jobs.pending} pending, ${m.jobs.running} running. Check that the worker is running and not saturated.`,
      linkPath: '/admin/operations',
      roles: ['super_admin'],
      value: lag,
      threshold: t.queueLagSeconds,
    });
  }
  if (reached(m.jobs.dead, t.deadJobs)) {
    alerts.push({
      key: 'jobs.dead',
      severity: 'warning',
      title: 'Jobs in the dead-letter queue',
      message: `${plural(m.jobs.dead, 'job')} exhausted their retries. Fix the cause, then retry them from Admin → Jobs & Outbox.`,
      linkPath: '/admin/operations',
      roles: ['super_admin'],
      value: m.jobs.dead,
      threshold: t.deadJobs,
    });
  }
  if (reached(m.outbox.stuck, t.stuckOutboxEvents)) {
    alerts.push({
      key: 'outbox.stuck',
      severity: 'warning',
      title: 'Outbox events are stuck',
      message: `${plural(m.outbox.stuck, 'business event')} could not be routed after repeated attempts and ${m.outbox.stuck === 1 ? 'is' : 'are'} no longer relayed. Requeue from Admin → Jobs & Outbox once fixed.`,
      linkPath: '/admin/operations',
      roles: ['super_admin'],
      value: m.outbox.stuck,
      threshold: t.stuckOutboxEvents,
    });
  }
  const outboxLag = m.outbox.oldestUnpublishedSeconds;
  if (outboxLag !== null && reached(outboxLag, t.outboxLagSeconds)) {
    alerts.push({
      key: 'outbox.lag',
      severity: 'critical',
      title: 'Outbox relay is not keeping up',
      message: `The oldest unpublished event is ${duration(outboxLag)} old (threshold ${duration(t.outboxLagSeconds)}); ${m.outbox.unpublished} unpublished. Notifications and follow-up jobs are delayed until the worker relays them.`,
      linkPath: '/admin/operations',
      roles: ['super_admin'],
      value: outboxLag,
      threshold: t.outboxLagSeconds,
    });
  }
  if (reached(m.webhooks.paymentFailuresLastHour, t.paymentWebhookFailuresPerHour)) {
    alerts.push({
      key: 'webhooks.payments',
      severity: 'warning',
      title: 'Payment webhooks are failing',
      message: `${plural(m.webhooks.paymentFailuresLastHour, 'payment webhook')} in the last hour had an invalid signature or failed processing (threshold ${t.paymentWebhookFailuresPerHour}). Check the Paystack secret and webhook URL; payments are reconciled by the scheduled check meanwhile.`,
      linkPath: '/admin/integrations/paystack',
      roles: ['finance', 'super_admin'],
      value: m.webhooks.paymentFailuresLastHour,
      threshold: t.paymentWebhookFailuresPerHour,
    });
  }
  if (reached(m.webhooks.smsRejectedLastHour, t.smsWebhookRejectionsPerHour)) {
    alerts.push({
      key: 'webhooks.sms',
      severity: 'warning',
      title: 'SMS webhooks are being rejected',
      message: `${plural(m.webhooks.smsRejectedLastHour, 'Termii webhook')} were rejected in the last hour (threshold ${t.smsWebhookRejectionsPerHour}). Delivery receipts and STOP replies may be missing; check the webhook signing secret.`,
      linkPath: '/admin/integrations/termii',
      roles: ['super_admin'],
      value: m.webhooks.smsRejectedLastHour,
      threshold: t.smsWebhookRejectionsPerHour,
    });
  }
  const calendar = m.calendar.failedSyncs + m.calendar.unhealthyConnections;
  if (reached(calendar, t.calendarSyncFailures)) {
    alerts.push({
      key: 'calendar.sync',
      severity: m.calendar.unhealthyConnections > 0 ? 'critical' : 'warning',
      title: 'Calendar sync failures',
      message: `${plural(m.calendar.failedSyncs, 'upcoming appointment')} failed to sync or conflict with Google Calendar and ${plural(m.calendar.unhealthyConnections, 'organiser connection')} ${m.calendar.unhealthyConnections === 1 ? 'is' : 'are'} degraded or expired. Retry the sync or reconnect the organiser.`,
      linkPath: '/admin/appointments',
      roles: ['operations_manager', 'super_admin'],
      value: calendar,
      threshold: t.calendarSyncFailures!,
    });
  }
  const storage =
    m.storage.scanFailuresLastHour + m.storage.stuckScanning + m.storage.unhealthyProviders.length;
  if (reached(storage, t.storageErrors)) {
    const providers = m.storage.unhealthyProviders.length
      ? ` Degraded: ${m.storage.unhealthyProviders.join(', ')}.`
      : '';
    alerts.push({
      key: 'storage.errors',
      severity: m.storage.unhealthyProviders.length > 0 ? 'critical' : 'warning',
      title: 'File storage or malware scanning errors',
      message: `${plural(m.storage.scanFailuresLastHour, 'upload')} failed scanning in the last hour and ${plural(m.storage.stuckScanning, 'upload')} ${m.storage.stuckScanning === 1 ? 'has' : 'have'} waited over ${t.scanStuckMinutes} min for a scan. Affected files stay quarantined.${providers}`,
      linkPath: '/admin/integrations',
      roles: ['super_admin'],
      value: storage,
      threshold: t.storageErrors!,
    });
  }
  if (
    m.sms.balance !== null &&
    t.smsBalanceMinimum !== null &&
    m.sms.balance < t.smsBalanceMinimum
  ) {
    alerts.push({
      key: 'sms.balance_low',
      severity: m.sms.balance <= 0 ? 'critical' : 'warning',
      title: 'SMS balance is low',
      message: `The Termii balance was ${m.sms.balance} at the last health check (minimum ${t.smsBalanceMinimum}). Top up the wallet before SMS delivery stops.`,
      linkPath: '/admin/integrations/termii',
      roles: ['super_admin', 'finance'],
      value: m.sms.balance,
      threshold: t.smsBalanceMinimum,
    });
  }
  if (reached(m.reviews.overdueReportReviews, t.overdueReportReviews)) {
    alerts.push({
      key: 'reviews.overdue',
      severity: 'warning',
      title: 'Report reviews are overdue',
      message: `${plural(m.reviews.overdueReportReviews, 'report')} ${m.reviews.overdueReportReviews === 1 ? 'has' : 'have'} been in review for more than ${t.reportReviewOverdueHours} h. Assign or chase the named reviewers.`,
      linkPath: '/admin/reports',
      roles: ['operations_manager'],
      value: m.reviews.overdueReportReviews,
      threshold: t.overdueReportReviews!,
    });
  }
  const sla = m.sla.overdueServiceRequests + m.sla.overdueWorkOrders;
  if (reached(sla, t.overdueSlaItems)) {
    alerts.push({
      key: 'sla.overdue',
      severity: 'warning',
      title: 'SLA items are overdue',
      message: `${plural(m.sla.overdueServiceRequests, 'service request')} and ${plural(m.sla.overdueWorkOrders, 'work order')} are past their SLA due time.`,
      linkPath: '/admin/service-requests',
      roles: ['operations_manager'],
      value: sla,
      threshold: t.overdueSlaItems!,
    });
  }
  return alerts;
}
