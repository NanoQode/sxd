import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  appendOutbox,
  schema,
  systemContext,
  withActor,
  type Database,
  type DbExecutor,
  type Transaction,
} from '@simplexd/db';
import {
  createInvoiceRecord,
  issueInvoiceTx,
  systemFinanceActor,
  type FinanceActor,
} from '@simplexd/finance';
import {
  apportionAllocation,
  daysOverdue,
  leaseLifecycleTarget,
  nextServiceDate,
  periodsDueForInvoicing,
  scheduleStatusFor,
  slaDueAt,
} from '@simplexd/domain/rentals';
import { evaluateTransition, leaseMachine } from '@simplexd/domain/workflow';
import type { JobRunner } from '../runner';

/**
 * Property management jobs. The worker cannot load the web app's server
 * modules (`server-only`, `@/` aliases), so the job bodies here follow
 * apps/web/src/server/rentals/jobs.ts (the same steps, exercised by the web
 * integration tests through `runRentInvoicing` and the staff
 * `POST /api/v1/rent/invoicing-runs` endpoint) and share every decision with
 * it through the pure functions of `@simplexd/domain/rentals`
 * (`periodsDueForInvoicing`, `apportionAllocation`, `scheduleStatusFor`,
 * `leaseLifecycleTarget`). Each lease runs in its own transaction under the
 * system context, serialised by an advisory lock, so one failing lease never
 * holds back the rest and every step is safe to re-run.
 *
 *  - `rent.generate_due_charges` (hourly): deposit invoices for newly active
 *    leases; `rent` invoices for periods due within the lead window (collected
 *    on the owner's behalf, estate segment when applicable); settled money
 *    mirrored into `rent_allocations`; overdue periods flagged once with a
 *    `rent.overdue` late notice; system lease transitions (expiring inside
 *    the notice window, ended after the end date); stale invitations expired.
 *  - `work_orders.sla_check` (every 15 minutes): open work orders past their
 *    SLA flagged once (`work_order.sla_breached`); recurring work orders
 *    raised from the asset register while `expansion.preventive_maintenance`
 *    is enabled.
 */

const INVOICE_LEAD_DAYS = 14;
const OPEN_WORK = [
  'requested',
  'triaged',
  'assigned',
  'in_progress',
  'awaiting_approval',
  'approved',
] as const;

type LeaseRow = typeof schema.leases.$inferSelect;
type ScheduleRow = typeof schema.rentSchedules.$inferSelect;

const today = (now: Date) => now.toISOString().slice(0, 10);

async function primaryTenant(tx: DbExecutor, leaseId: string): Promise<string | null> {
  const [party] = await tx
    .select({ userId: schema.leaseParties.userId })
    .from(schema.leaseParties)
    .where(
      and(
        eq(schema.leaseParties.leaseId, leaseId),
        eq(schema.leaseParties.role, 'tenant'),
        eq(schema.leaseParties.accessStatus, 'active'),
      ),
    )
    .orderBy(asc(schema.leaseParties.createdAt))
    .limit(1);
  return party?.userId ?? null;
}

async function activePartyIds(tx: DbExecutor, leaseId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: schema.leaseParties.userId })
    .from(schema.leaseParties)
    .where(
      and(eq(schema.leaseParties.leaseId, leaseId), eq(schema.leaseParties.accessStatus, 'active')),
    );
  return rows.map((r) => r.userId).filter((v): v is string => Boolean(v));
}

async function estateSegment(tx: DbExecutor, propertyId: string): Promise<string | null> {
  const [row] = await tx
    .select({ segment: schema.estates.ledgerSegment })
    .from(schema.properties)
    .innerJoin(schema.estates, eq(schema.estates.id, schema.properties.estateId))
    .where(eq(schema.properties.id, propertyId));
  return row?.segment ?? null;
}

/** Charges of the lease that are still owed or paid (charges of waived periods are left out). */
async function liveCharges(tx: DbExecutor, leaseId: string) {
  const rows = await tx
    .select({ charge: schema.rentCharges })
    .from(schema.rentCharges)
    .leftJoin(schema.rentSchedules, eq(schema.rentSchedules.id, schema.rentCharges.scheduleId))
    .where(
      and(
        eq(schema.rentCharges.leaseId, leaseId),
        or(isNull(schema.rentCharges.scheduleId), sql`${schema.rentSchedules.status} <> 'waived'`),
      ),
    )
    .orderBy(
      asc(schema.rentCharges.chargedAt),
      asc(schema.rentCharges.createdAt),
      asc(schema.rentCharges.id),
    );
  return rows.map((r) => r.charge);
}

async function invoiceDeposit(
  tx: Transaction,
  fa: FinanceActor,
  lease: LeaseRow,
  now: Date,
): Promise<string | null> {
  const [charge] = await tx
    .select()
    .from(schema.rentCharges)
    .where(
      and(
        eq(schema.rentCharges.leaseId, lease.id),
        eq(schema.rentCharges.kind, 'deposit'),
        isNull(schema.rentCharges.invoiceId),
      ),
    )
    .limit(1);
  if (!charge) return null;
  const draft = await createInvoiceRecord(tx, fa, {
    organizationId: lease.organizationId,
    customerUserId: await primaryTenant(tx, lease.id),
    kind: 'deposit',
    currency: lease.currency,
    dueDate: lease.startDate,
    notes: 'Security deposit held for the tenancy',
    lines: [
      {
        description: charge.description,
        quantity: '1',
        unitAmountKobo: charge.amountKobo.toString(),
      },
    ],
    createdBy: null,
  });
  const [linked] = await tx
    .update(schema.invoices)
    .set({ leaseId: lease.id })
    .where(eq(schema.invoices.id, draft.id))
    .returning();
  const issued = await issueInvoiceTx(tx, fa, linked!, { now, dueDate: lease.startDate });
  await tx
    .update(schema.rentCharges)
    .set({ invoiceId: issued.id })
    .where(eq(schema.rentCharges.id, charge.id));
  return issued.id;
}

async function invoiceSchedule(
  tx: Transaction,
  fa: FinanceActor,
  schedule: ScheduleRow,
  lease: LeaseRow,
  now: Date,
): Promise<string | null> {
  const open = await tx
    .select()
    .from(schema.rentCharges)
    .where(
      and(
        eq(schema.rentCharges.leaseId, lease.id),
        isNull(schema.rentCharges.invoiceId),
        sql`(${schema.rentCharges.scheduleId} = ${schedule.id} OR (${schema.rentCharges.scheduleId} IS NULL AND ${schema.rentCharges.kind} <> 'deposit'))`,
      ),
    )
    .orderBy(asc(schema.rentCharges.chargedAt), asc(schema.rentCharges.id));
  const charges = open.filter((c) => c.amountKobo > 0n);
  if (charges.length === 0) {
    // Nothing to collect for this period (a zero-rent period): it is closed as waived.
    await tx
      .update(schema.rentSchedules)
      .set({ status: 'waived' })
      .where(eq(schema.rentSchedules.id, schedule.id));
    return null;
  }
  const draft = await createInvoiceRecord(tx, fa, {
    organizationId: lease.organizationId,
    customerUserId: await primaryTenant(tx, lease.id),
    kind: 'rent',
    currency: lease.currency,
    taxTreatmentKey: null,
    dueDate: schedule.dueDate,
    notes: `Rent for ${schedule.periodStart} to ${schedule.periodEnd}`,
    lines: charges.map((c) => ({
      description: c.description,
      quantity: '1',
      unitAmountKobo: c.amountKobo.toString(),
    })),
    createdBy: null,
  });
  const [linked] = await tx
    .update(schema.invoices)
    .set({
      leaseId: lease.id,
      isRentOnBehalfOfOwner: true,
      // The owner is the invoice organisation; see apps/web/src/server/rentals/schedules.ts for
      // why `ownerOrganizationId` stays null until the `invoiceIssued` posting is fixed.
      ownerOrganizationId: null,
      estateSegment: await estateSegment(tx, lease.propertyId),
    })
    .where(eq(schema.invoices.id, draft.id))
    .returning();
  const issued = await issueInvoiceTx(tx, fa, linked!, { now, dueDate: schedule.dueDate });
  await tx
    .update(schema.rentCharges)
    .set({ invoiceId: issued.id })
    .where(
      inArray(
        schema.rentCharges.id,
        charges.map((c) => c.id),
      ),
    );
  await tx
    .update(schema.rentSchedules)
    .set({ status: 'invoiced', invoiceId: issued.id })
    .where(eq(schema.rentSchedules.id, schedule.id));
  await appendOutbox(tx, {
    eventType: 'rent.invoice_issued',
    aggregateType: 'lease',
    aggregateId: lease.id,
    organizationId: lease.organizationId,
    actorUserId: null,
    payload: {
      leaseId: lease.id,
      scheduleId: schedule.id,
      invoiceId: issued.id,
      invoiceNumber: issued.number,
      dueDate: schedule.dueDate,
      totalKobo: issued.totalKobo.toString(),
      recipientUserIds: [issued.customerUserId].filter(Boolean),
    },
    correlationId: fa.correlationId ?? null,
  });
  return issued.id;
}

/** Mirrors finance allocations into rent allocations and refreshes schedule statuses. */
async function syncAllocations(tx: DbExecutor, lease: LeaseRow, asOf: string): Promise<number> {
  const invoices = await tx
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(eq(schema.invoices.leaseId, lease.id));
  if (invoices.length === 0) return 0;
  const allocations = await tx
    .select()
    .from(schema.allocations)
    .where(
      inArray(
        schema.allocations.invoiceId,
        invoices.map((i) => i.id),
      ),
    )
    .orderBy(asc(schema.allocations.allocatedAt), asc(schema.allocations.id));
  const mirroredRows = await tx
    .select({
      allocationId: schema.rentAllocations.allocationId,
      rentChargeId: schema.rentAllocations.rentChargeId,
      amountKobo: schema.rentAllocations.amountKobo,
    })
    .from(schema.rentAllocations)
    .where(eq(schema.rentAllocations.leaseId, lease.id));
  const existing = new Set(mirroredRows.map((r) => r.allocationId));
  const paid = new Map<string, bigint>();
  for (const r of mirroredRows)
    paid.set(r.rentChargeId, (paid.get(r.rentChargeId) ?? 0n) + r.amountKobo);
  const charges = await liveCharges(tx, lease.id);
  for (const a of allocations) {
    if (existing.has(a.id)) continue;
    const parts = apportionAllocation(
      a.amountKobo,
      charges.filter((c) => c.invoiceId === a.invoiceId),
      paid,
    );
    for (const part of parts) {
      await tx.insert(schema.rentAllocations).values({
        leaseId: lease.id,
        rentChargeId: part.chargeId,
        allocationId: a.id,
        amountKobo: part.amountKobo,
        allocatedBy: a.allocatedBy && a.allocatedBy !== 'system' ? a.allocatedBy : null,
        journalId: a.journalId,
      });
      paid.set(part.chargeId, (paid.get(part.chargeId) ?? 0n) + part.amountKobo);
    }
    existing.add(a.id);
  }
  let overdue = 0;
  const schedules = await tx
    .select()
    .from(schema.rentSchedules)
    .where(eq(schema.rentSchedules.leaseId, lease.id));
  for (const s of schedules) {
    const own = charges.filter((c) => c.scheduleId === s.id);
    const total = own.reduce((sum, c) => sum + c.amountKobo, 0n);
    const settled = own.reduce((sum, c) => sum + (paid.get(c.id) ?? 0n), 0n);
    const next = scheduleStatusFor(s.status, total, settled, s.dueDate, asOf);
    if (next === s.status) continue;
    await tx
      .update(schema.rentSchedules)
      .set({ status: next })
      .where(eq(schema.rentSchedules.id, s.id));
    if (next !== 'overdue') continue;
    overdue += 1;
    await appendOutbox(tx, {
      eventType: 'rent.overdue',
      aggregateType: 'lease',
      aggregateId: lease.id,
      organizationId: lease.organizationId,
      actorUserId: null,
      payload: {
        leaseId: lease.id,
        scheduleId: s.id,
        invoiceId: s.invoiceId,
        dueDate: s.dueDate,
        outstandingKobo: (total - settled).toString(),
        daysOverdue: daysOverdue(s.dueDate, asOf),
        recipientUserIds: await activePartyIds(tx, lease.id),
      },
      correlationId: null,
    });
  }
  return overdue;
}

/** System lease transition (`leaseMachine`): expiring inside the notice window, ended after the end date. */
async function advanceLifecycle(
  tx: DbExecutor,
  lease: LeaseRow,
  asOf: string,
  correlationId: string,
): Promise<'expiring' | 'ended' | null> {
  const target = leaseLifecycleTarget(lease, asOf);
  if (!target) return null;
  const decision = evaluateTransition(leaseMachine, {
    from: lease.status,
    to: target,
    actor: 'system',
  });
  if (!decision.ok) return null;
  const [row] = await tx
    .update(schema.leases)
    .set({ status: target, version: lease.version + 1 })
    .where(and(eq(schema.leases.id, lease.id), eq(schema.leases.version, lease.version)))
    .returning({ version: schema.leases.version });
  if (!row) return null;
  await tx.insert(schema.auditEvents).values({
    actorType: 'job',
    organizationId: lease.organizationId,
    action: `lease.${target}`,
    entityType: 'lease',
    entityId: lease.id,
    before: { status: lease.status, version: lease.version },
    after: { status: target, version: row.version },
    correlationId,
  });
  await appendOutbox(tx, {
    eventType: 'lease.transitioned',
    aggregateType: 'lease',
    aggregateId: lease.id,
    organizationId: lease.organizationId,
    actorUserId: null,
    payload: {
      leaseId: lease.id,
      from: lease.status,
      to: target,
      reason: null,
      recipientUserIds: await activePartyIds(tx, lease.id),
    },
    correlationId,
  });
  if (target === 'ended' && lease.unitId) {
    const [other] = await tx
      .select({ id: schema.leases.id })
      .from(schema.leases)
      .where(
        and(
          eq(schema.leases.unitId, lease.unitId),
          ne(schema.leases.id, lease.id),
          inArray(schema.leases.status, ['active', 'expiring']),
        ),
      )
      .limit(1);
    if (!other)
      await tx
        .update(schema.units)
        .set({ status: 'vacant' })
        .where(eq(schema.units.id, lease.unitId));
  }
  return target;
}

export interface RentRunSummary {
  leases: number;
  invoiced: number;
  skipped: number;
  overdue: number;
  transitions: number;
  failed: number;
  expiredInvitations: number;
}

export async function runRentJob(
  db: Database,
  log: Pick<Logger, 'error'>,
  now: Date = new Date(),
  correlationId?: string,
): Promise<RentRunSummary> {
  const asOf = today(now);
  const cid = correlationId ?? `rent-job:${asOf}`;
  const ctx = systemContext(cid);
  const fa = systemFinanceActor(cid);
  const summary: RentRunSummary = {
    leases: 0,
    invoiced: 0,
    skipped: 0,
    overdue: 0,
    transitions: 0,
    failed: 0,
    expiredInvitations: 0,
  };
  const leaseIds = await withActor(db, ctx, async (tx) =>
    (
      await tx
        .select({ id: schema.leases.id })
        .from(schema.leases)
        .where(
          or(
            inArray(schema.leases.status, ['active', 'expiring']),
            sql`exists (select 1 from rent_schedules rs where rs.lease_id = ${schema.leases.id}
                  and rs.status in ('invoiced', 'partially_paid', 'overdue'))`,
          ),
        )
        .orderBy(asc(schema.leases.createdAt), asc(schema.leases.id))
    ).map((r) => r.id),
  );
  for (const leaseId of leaseIds) {
    try {
      const step = await withActor(db, ctx, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`lease:${leaseId}`}))`);
        const [lease] = await tx.select().from(schema.leases).where(eq(schema.leases.id, leaseId));
        if (!lease) return null;
        let invoiced = 0;
        let skipped = 0;
        if (lease.status === 'active' || lease.status === 'expiring') {
          if (await invoiceDeposit(tx, fa, lease, now)) invoiced += 1;
          const schedules = await tx
            .select()
            .from(schema.rentSchedules)
            .where(eq(schema.rentSchedules.leaseId, lease.id))
            .orderBy(asc(schema.rentSchedules.dueDate));
          for (const s of periodsDueForInvoicing(schedules, asOf, INVOICE_LEAD_DAYS)) {
            if (await invoiceSchedule(tx, fa, s, lease, now)) invoiced += 1;
            else skipped += 1;
          }
        }
        const overdue = await syncAllocations(tx, lease, asOf);
        const transition = await advanceLifecycle(tx, lease, asOf, cid);
        return { invoiced, skipped, overdue, transition };
      });
      if (!step) continue;
      summary.leases += 1;
      summary.invoiced += step.invoiced;
      summary.skipped += step.skipped;
      summary.overdue += step.overdue;
      if (step.transition) summary.transitions += 1;
    } catch (err) {
      summary.failed += 1;
      log.error({ err, leaseId, correlationId: cid }, 'rent job step failed for a lease');
    }
  }
  summary.expiredInvitations = await withActor(db, ctx, async (tx) => {
    const expired = await tx
      .update(schema.leaseParties)
      .set({ accessStatus: 'expired', invitationTokenHash: null })
      .where(
        and(
          eq(schema.leaseParties.accessStatus, 'invited'),
          lt(schema.leaseParties.invitationExpiresAt, now),
        ),
      )
      .returning({ id: schema.leaseParties.id });
    return expired.length;
  });
  return summary;
}

export async function runSlaJob(
  db: Database,
  now: Date = new Date(),
): Promise<{ breached: number; recurring: number }> {
  return withActor(db, systemContext('work_orders.sla_check'), async (tx) => {
    let breached = 0;
    const open = await tx
      .select()
      .from(schema.workOrders)
      .where(
        and(lt(schema.workOrders.slaDueAt, now), inArray(schema.workOrders.status, [...OPEN_WORK])),
      );
    for (const row of open) {
      const [already] = await tx
        .select({ id: schema.auditEvents.id })
        .from(schema.auditEvents)
        .where(
          and(
            eq(schema.auditEvents.entityType, 'work_order'),
            eq(schema.auditEvents.entityId, row.id),
            eq(schema.auditEvents.action, 'work_order.sla_breached'),
          ),
        )
        .limit(1);
      if (already) continue;
      await tx.insert(schema.auditEvents).values({
        actorType: 'job',
        organizationId: row.organizationId,
        action: 'work_order.sla_breached',
        entityType: 'work_order',
        entityId: row.id,
        after: {
          status: row.status,
          slaDueAt: row.slaDueAt?.toISOString() ?? null,
          priority: row.priority,
        },
      });
      await appendOutbox(tx, {
        eventType: 'work_order.sla_breached',
        aggregateType: 'work_order',
        aggregateId: row.id,
        organizationId: row.organizationId,
        actorUserId: null,
        payload: {
          workOrderId: row.id,
          status: row.status,
          priority: row.priority,
          slaDueAt: row.slaDueAt?.toISOString() ?? null,
          assigneeUserId: row.assigneeUserId,
        },
        correlationId: null,
      });
      breached += 1;
    }

    let recurring = 0;
    const [flag] = await tx
      .select({ enabled: schema.featureFlags.enabled })
      .from(schema.featureFlags)
      .where(eq(schema.featureFlags.key, 'expansion.preventive_maintenance'));
    if (flag?.enabled) {
      const asOf = today(now);
      const due = await tx
        .select()
        .from(schema.assets)
        .where(
          and(
            sql`${schema.assets.nextServiceAt} <= ${asOf}`,
            sql`${schema.assets.serviceIntervalDays} IS NOT NULL`,
          ),
        );
      for (const asset of due) {
        const [openForAsset] = await tx
          .select({ id: schema.workOrders.id })
          .from(schema.workOrders)
          .where(
            and(
              eq(schema.workOrders.assetId, asset.id),
              inArray(schema.workOrders.status, [...OPEN_WORK]),
            ),
          )
          .limit(1);
        if (!openForAsset) {
          const [row] = await tx
            .insert(schema.workOrders)
            .values({
              organizationId: asset.organizationId,
              propertyId: asset.propertyId,
              assetId: asset.id,
              estateId: asset.estateId,
              title: `Scheduled service: ${asset.name}`,
              description: `Recurring service every ${asset.serviceIntervalDays} days (due ${asset.nextServiceAt}).`,
              category: 'preventive',
              priority: 'normal',
              status: 'requested',
              slaDueAt: slaDueAt('normal', now),
              recurring: {
                assetId: asset.id,
                intervalDays: asset.serviceIntervalDays,
                dueOn: asset.nextServiceAt,
              },
            })
            .returning();
          await tx.insert(schema.auditEvents).values({
            actorType: 'job',
            organizationId: asset.organizationId,
            action: 'work_order.requested',
            entityType: 'work_order',
            entityId: row!.id,
            after: { assetId: asset.id, recurring: true },
          });
          await appendOutbox(tx, {
            eventType: 'work_order.transitioned',
            aggregateType: 'work_order',
            aggregateId: row!.id,
            organizationId: asset.organizationId,
            actorUserId: null,
            payload: { workOrderId: row!.id, from: null, to: 'requested', title: row!.title },
            correlationId: null,
          });
          recurring += 1;
        }
        await tx
          .update(schema.assets)
          .set({ nextServiceAt: nextServiceDate(asOf, asset.serviceIntervalDays) })
          .where(eq(schema.assets.id, asset.id));
      }
    }
    return { breached, recurring };
  });
}

export function registerRentalHandlers(runner: JobRunner): void {
  runner.register('rent.generate_due_charges', async ({ db, log, job }) => {
    const summary = await runRentJob(db, log, new Date(), job.correlationId ?? undefined);
    if (
      summary.invoiced > 0 ||
      summary.overdue > 0 ||
      summary.transitions > 0 ||
      summary.failed > 0 ||
      summary.expiredInvitations > 0
    )
      log.info(summary, 'rent job run');
  });

  runner.register('work_orders.sla_check', async ({ db, log }) => {
    const summary = await runSlaJob(db);
    if (summary.breached > 0 || summary.recurring > 0) log.info(summary, 'work order SLA check');
  });
}
