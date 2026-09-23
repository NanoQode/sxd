import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTBOX_MAX_ATTEMPTS, schema, systemContext, withActor } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { alertEntityId, alertWindow, monitoringSnapshot, raiseAlerts } from './alerts';
import { collectMonitoringMetrics } from './collect';
import {
  DEFAULT_THRESHOLDS,
  evaluateThresholds,
  resolveThresholds,
  type MonitoringMetrics,
  type OpsAlert,
} from './thresholds';

const healthy = (): MonitoringMetrics => ({
  jobs: { pending: 3, running: 1, dead: 0, oldestPendingSeconds: 5 },
  outbox: { unpublished: 2, stuck: 0, oldestUnpublishedSeconds: 1 },
  webhooks: { paymentFailuresLastHour: 0, smsRejectedLastHour: 0 },
  calendar: { failedSyncs: 0, unhealthyConnections: 0 },
  storage: { scanFailuresLastHour: 0, stuckScanning: 0, unhealthyProviders: [] },
  sms: { balance: 25_000, checkedAt: '2026-09-23T10:00:00.000Z' },
  reviews: { overdueReportReviews: 0 },
  sla: { overdueServiceRequests: 0, overdueWorkOrders: 0 },
});

const keys = (alerts: OpsAlert[]) => alerts.map((a) => a.key);

describe('evaluateThresholds', () => {
  it('raises nothing for healthy metrics or an unknown SMS balance', () => {
    expect(evaluateThresholds(healthy(), DEFAULT_THRESHOLDS)).toEqual([]);
    const m = healthy();
    m.sms = { balance: null, checkedAt: null };
    m.jobs.oldestPendingSeconds = null;
    m.outbox.oldestUnpublishedSeconds = null;
    expect(evaluateThresholds(m, DEFAULT_THRESHOLDS)).toEqual([]);
  });

  it('raises each alert at its threshold, not below it', () => {
    const t = DEFAULT_THRESHOLDS;
    const cases: Array<[string, (m: MonitoringMetrics, atThreshold: boolean) => void]> = [
      ['queue.lag', (m, at) => (m.jobs.oldestPendingSeconds = t.queueLagSeconds! - (at ? 0 : 1))],
      ['jobs.dead', (m, at) => (m.jobs.dead = at ? 1 : 0)],
      ['outbox.stuck', (m, at) => (m.outbox.stuck = at ? 1 : 0)],
      [
        'outbox.lag',
        (m, at) => (m.outbox.oldestUnpublishedSeconds = t.outboxLagSeconds! - (at ? 0 : 1)),
      ],
      [
        'webhooks.payments',
        (m, at) =>
          (m.webhooks.paymentFailuresLastHour = t.paymentWebhookFailuresPerHour! - (at ? 0 : 1)),
      ],
      [
        'webhooks.sms',
        (m, at) => (m.webhooks.smsRejectedLastHour = t.smsWebhookRejectionsPerHour! - (at ? 0 : 1)),
      ],
      ['calendar.sync', (m, at) => (m.calendar.failedSyncs = at ? 1 : 0)],
      ['storage.errors', (m, at) => (m.storage.stuckScanning = at ? 1 : 0)],
      ['sms.balance_low', (m, at) => (m.sms.balance = t.smsBalanceMinimum! - (at ? 1 : 0))],
      ['reviews.overdue', (m, at) => (m.reviews.overdueReportReviews = at ? 1 : 0)],
      ['sla.overdue', (m, at) => (m.sla.overdueWorkOrders = at ? 1 : 0)],
    ];
    for (const [key, set] of cases) {
      const below = healthy();
      set(below, false);
      expect(keys(evaluateThresholds(below, t)), `${key} below`).toEqual([]);
      const at = healthy();
      set(at, true);
      expect(keys(evaluateThresholds(at, t)), `${key} at threshold`).toEqual([key]);
    }
  });

  it('addresses the roles that act on each alert and links into the admin', () => {
    const m = healthy();
    m.jobs.dead = 2;
    m.webhooks.paymentFailuresLastHour = 9;
    m.calendar.unhealthyConnections = 1;
    m.sms.balance = 100;
    m.sla.overdueServiceRequests = 3;
    const byKey = Object.fromEntries(
      evaluateThresholds(m, DEFAULT_THRESHOLDS).map((a) => [a.key, a]),
    );
    expect(byKey['jobs.dead']).toMatchObject({
      roles: ['super_admin'],
      linkPath: '/admin/operations',
      value: 2,
      threshold: 1,
    });
    expect(byKey['webhooks.payments']).toMatchObject({
      roles: ['finance', 'super_admin'],
      linkPath: '/admin/integrations/paystack',
    });
    expect(byKey['calendar.sync']).toMatchObject({
      severity: 'critical',
      roles: ['operations_manager', 'super_admin'],
    });
    expect(byKey['sms.balance_low']).toMatchObject({
      roles: ['super_admin', 'finance'],
      value: 100,
      threshold: 5000,
    });
    expect(byKey['sla.overdue']).toMatchObject({ roles: ['operations_manager'], value: 3 });
    for (const alert of Object.values(byKey)) {
      expect(alert.linkPath.startsWith('/admin')).toBe(true);
      expect(alert.message).not.toMatch(/@|\+234/);
    }
  });

  it('escalates queue lag to critical at three times the threshold', () => {
    const m = healthy();
    m.jobs.oldestPendingSeconds = 1800;
    expect(evaluateThresholds(m, DEFAULT_THRESHOLDS)[0]).toMatchObject({
      key: 'queue.lag',
      severity: 'critical',
    });
    m.jobs.oldestPendingSeconds = 700;
    expect(evaluateThresholds(m, DEFAULT_THRESHOLDS)[0]!.severity).toBe('warning');
  });

  it('switches a check off with a null threshold', () => {
    const m = healthy();
    m.jobs.dead = 50;
    m.sms.balance = 0;
    expect(
      keys(
        evaluateThresholds(m, { ...DEFAULT_THRESHOLDS, deadJobs: null, smsBalanceMinimum: null }),
      ),
    ).toEqual([]);
  });
});

describe('resolveThresholds', () => {
  it('merges valid overrides onto the defaults and ignores the rest', () => {
    expect(resolveThresholds(undefined)).toEqual(DEFAULT_THRESHOLDS);
    expect(resolveThresholds('nope')).toEqual(DEFAULT_THRESHOLDS);
    const t = resolveThresholds({
      queueLagSeconds: 900,
      deadJobs: null,
      smsBalanceMinimum: -5,
      storageErrors: 'many',
      scanStuckMinutes: null,
      reportReviewOverdueHours: 0,
      unknownKey: 1,
    });
    expect(t).toEqual({ ...DEFAULT_THRESHOLDS, queueLagSeconds: 900, deadJobs: null });
  });
});

describe('alerts against the database', () => {
  let dbs: TestDatabases;
  const run = uniqueSuffix();
  const key = `test.${run}`;
  const alert: OpsAlert = {
    key,
    severity: 'warning',
    title: 'Test alert',
    message: '3 things crossed a threshold.',
    linkPath: '/admin/operations',
    roles: ['super_admin'],
    value: 3,
    threshold: 1,
  };
  class Rollback extends Error {}

  beforeAll(() => {
    dbs = connectTestDatabases();
  });

  afterAll(async () => {
    await dbs.owner
      .delete(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.eventType, 'ops.alert'),
          like(schema.outboxEvents.aggregateId, `${key}@%`),
        ),
      );
    await dbs.close();
  });

  const events = () =>
    dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.eventType, 'ops.alert'),
          like(schema.outboxEvents.aggregateId, `${key}@%`),
        ),
      )
      .orderBy(schema.outboxEvents.id);

  it('emits one ops.alert per key per hour, recorded in the audit log', async () => {
    const now = new Date('2026-09-23T10:15:00Z');
    const sys = <T>(fn: Parameters<typeof withActor<T>>[2]) =>
      withActor(dbs.app, systemContext(`monitoring-${run}`), fn);

    expect(
      await sys((tx) => raiseAlerts(tx, [alert], { now, correlationId: `corr-${run}` })),
    ).toEqual({
      raised: [key],
      suppressed: [],
    });
    // Same hour: suppressed, whether the same process or another worker raises it.
    const later = new Date('2026-09-23T10:59:59Z');
    expect(await sys((tx) => raiseAlerts(tx, [alert], { now: later }))).toEqual({
      raised: [],
      suppressed: [key],
    });
    // Next hour: raised again.
    const nextHour = new Date('2026-09-23T11:00:00Z');
    expect(await sys((tx) => raiseAlerts(tx, [alert], { now: nextHour }))).toEqual({
      raised: [key],
      suppressed: [],
    });

    const rows = await events();
    expect(rows.map((r) => r.aggregateId)).toEqual([
      alertEntityId(key, '2026-09-23T10:00:00.000Z'),
      alertEntityId(key, '2026-09-23T11:00:00.000Z'),
    ]);
    expect(rows[0]).toMatchObject({
      aggregateType: 'ops_alert',
      organizationId: null,
      correlationId: `corr-${run}`,
      publishedAt: null,
    });
    expect(rows[0]!.payload).toEqual({ ...alert, window: '2026-09-23T10:00:00.000Z' });

    const audit = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.entityType, 'ops_alert'),
          like(schema.auditEvents.entityId, `${key}@%`),
        ),
      );
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ actorType: 'system', action: 'ops.alert_raised' });
  });

  it('serialises concurrent monitoring runs so only one raises the alert', async () => {
    const now = new Date('2026-09-23T14:30:00Z');
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        withActor(dbs.app, systemContext(), (tx) => raiseAlerts(tx, [alert], { now })),
      ),
    );
    expect(results.flatMap((r) => r.raised)).toEqual([key]);
    expect(results.flatMap((r) => r.suppressed)).toHaveLength(2);
    expect(alertWindow(now)).toBe('2026-09-23T14:00:00.000Z');
  });

  it('collects metrics from the operational tables', async () => {
    const now = new Date();
    const measure = () =>
      withActor(dbs.app, systemContext(), (tx) =>
        collectMonitoringMetrics(tx, { now, thresholds: DEFAULT_THRESHOLDS }),
      );
    const before = await measure();
    for (const n of [
      before.jobs.pending,
      before.jobs.dead,
      before.outbox.stuck,
      before.webhooks.paymentFailuresLastHour,
      before.webhooks.smsRejectedLastHour,
      before.calendar.failedSyncs,
      before.storage.stuckScanning,
      before.reviews.overdueReportReviews,
      before.sla.overdueWorkOrders,
    ])
      expect(Number.isInteger(n) && n >= 0).toBe(true);

    await dbs.owner.insert(schema.providerEvents).values({
      provider: 'paystack',
      environment: 'test',
      dedupeKey: `monitoring-${run}`,
      eventType: 'charge.success',
      signatureValid: false,
      rawBody: '{}',
      processingStatus: 'ignored',
    });
    await dbs.owner.insert(schema.integrationLogs).values({
      provider: 'termii',
      environment: 'test',
      level: 'warn',
      event: 'webhook.rejected',
      messageSanitized: 'signature mismatch',
    });
    await dbs.owner.insert(schema.outboxEvents).values({
      eventType: 'monitoring.test',
      aggregateType: 'monitoring_test',
      aggregateId: `${key}@stuck`,
      payload: {},
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
    try {
      const after = await measure();
      expect(after.webhooks.paymentFailuresLastHour).toBeGreaterThanOrEqual(
        before.webhooks.paymentFailuresLastHour + 1,
      );
      expect(after.webhooks.smsRejectedLastHour).toBeGreaterThanOrEqual(
        before.webhooks.smsRejectedLastHour + 1,
      );
      expect(after.outbox.stuck).toBeGreaterThanOrEqual(before.outbox.stuck + 1);
    } finally {
      await dbs.owner
        .delete(schema.outboxEvents)
        .where(eq(schema.outboxEvents.aggregateId, `${key}@stuck`));
    }
  });

  it('runs a whole snapshot: thresholds from settings, metrics, alerts (rolled back)', async () => {
    await expect(
      withActor(dbs.app, systemContext(), async (tx) => {
        await tx
          .insert(schema.settings)
          .values({ key: 'monitoring.thresholds', value: { deadJobs: 0, queueLagSeconds: null } })
          .onConflictDoUpdate({
            target: schema.settings.key,
            set: { value: { deadJobs: 0, queueLagSeconds: null } },
          });
        const snapshot = await monitoringSnapshot(tx, { now: new Date('2030-01-01T00:00:00Z') });
        // deadJobs: 0 always fires; queue lag is switched off.
        expect(snapshot.alerts.map((a) => a.key)).toContain('jobs.dead');
        expect(snapshot.alerts.map((a) => a.key)).not.toContain('queue.lag');
        expect(snapshot.raised).toContain('jobs.dead');
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });
});
