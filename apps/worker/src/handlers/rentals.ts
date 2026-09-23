import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
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
  compareDates,
  nextServiceDate,
  periodsDueForInvoicing,
  slaDueAt,
} from '@simplexd/domain/rentals';
import type { JobRunner } from '../runner';

/**
 * Property management jobs. The worker cannot load the web app's server
 * modules (`server-only`, `@/` aliases), so the job bodies here mirror
 * apps/web/src/server/rentals/schedules.ts and
 * apps/web/src/server/maintenance/work-orders.ts and are covered by the
 * integration tests there. Every step is idempotent and safe to re-run.
 *
 *  - `rent.generate_due_charges` (hourly): deposit invoices for newly active
 *    leases, `rent` invoices for periods due within the lead window (collected
 *    on the owner's behalf, estate segment when applicable), settled money
 *    mirrored into `rent_allocations`, overdue periods flagged once with a
 *    `rent.overdue` late-notice event, stale invitations expired.
 *  - `work_orders.sla_check` (every 15 minutes): open work orders past their
 *    SLA flagged once (`work_order.sla_breached`), recurring work orders
 *    raised from the asset register when `expansion.preventive_maintenance`
 *    is enabled.
 */

const INVOICE_LEAD_DAYS = 14;
const OPEN_WORK = ['requested', 'triaged', 'assigned', 'in_progress', 'awaiting_approval', 'approved'] as const;

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

async function estateSegment(tx: DbExecutor, propertyId: string): Promise<string | null> {
  const [row] = await tx
    .select({ segment: schema.estates.ledgerSegment })
    .from(schema.properties)
    .innerJoin(schema.estates, eq(schema.estates.id, schema.properties.estateId))
    .where(eq(schema.properties.id, propertyId));
  return row?.segment ?? null;
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
    lines: [{ description: charge.description, quantity: '1', unitAmountKobo: charge.amountKobo.toString() }],
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
  const charges = await tx
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
  if (charges.length === 0) return null;
  const draft = await createInvoiceRecord(tx, fa, {
    organizationId: lease.organizationId,
    customerUserId: await primaryTenant(tx, lease.id),
    kind: 'rent',
    currency: lease.currency,
    dueDate: schedule.dueDate,
    notes: `Rent for ${schedule.periodStart} to ${schedule.periodEnd}`,
    lines: charges.map((c) => ({ description: c.description, quantity: '1', unitAmountKobo: c.amountKobo.toString() })),
  });
  const [linked] = await tx
    .update(schema.invoices)
    .set({
      leaseId: lease.id,
      isRentOnBehalfOfOwner: true,
      // See apps/web/src/server/rentals/schedules.ts: the owner is the invoice organisation.
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

/** Mirrors finance allocations into rent allocations and refreshes schedule statuses (see the web module). */
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
  const existing = new Set(
    (
      await tx
        .select({ allocationId: schema.rentAllocations.allocationId })
        .from(schema.rentAllocations)
        .where(eq(schema.rentAllocations.leaseId, lease.id))
    ).map((r) => r.allocationId),
  );
  const charges = await tx
    .select()
    .from(schema.rentCharges)
    .where(eq(schema.rentCharges.leaseId, lease.id))
    .orderBy(asc(schema.rentCharges.chargedAt), asc(schema.rentCharges.createdAt), asc(schema.rentCharges.id));
  const paid = new Map<string, bigint>();
  for (const r of await tx
    .select({ rentChargeId: schema.rentAllocations.rentChargeId, amountKobo: schema.rentAllocations.amountKobo })
    .from(schema.rentAllocations)
    .where(eq(schema.rentAllocations.leaseId, lease.id))) {
    paid.set(r.rentChargeId, (paid.get(r.rentChargeId) ?? 0n) + r.amountKobo);
  }
  for (const a of allocations) {
    if (existing.has(a.id)) continue;
    let remaining = a.amountKobo;
    for (const c of charges.filter((c) => c.invoiceId === a.invoiceId)) {
      if (remaining <= 0n) break;
      const open = c.amountKobo - (paid.get(c.id) ?? 0n);
      if (open <= 0n) continue;
      const take = open < remaining ? open : remaining;
      await tx.insert(schema.rentAllocations).values({
        leaseId: lease.id,
        rentChargeId: c.id,
        allocationId: a.id,
        amountKobo: take,
        allocatedBy: a.allocatedBy && a.allocatedBy !== 'system' ? a.allocatedBy : null,
        journalId: a.journalId,
      });
      paid.set(c.id, (paid.get(c.id) ?? 0n) + take);
      remaining -= take;
    }
    existing.add(a.id);
  }
  let overdue = 0;
  const schedules = await tx
    .select()
    .from(schema.rentSchedules)
    .where(eq(schema.rentSchedules.leaseId, lease.id));
  for (const s of schedules) {
    if (s.status === 'scheduled' || s.status === 'waived') continue;
    const own = charges.filter((c) => c.scheduleId === s.id);
    const total = own.reduce((sum, c) => sum + c.amountKobo, 0n);
    const settled = own.reduce((sum, c) => sum + (paid.get(c.id) ?? 0n), 0n);
    let next: ScheduleRow['status'];
    if (total > 0n && settled >= total) next = 'paid';
    else if (compareDates(s.dueDate, asOf) < 0) next = 'overdue';
    else next = settled > 0n ? 'partially_paid' : 'invoiced';
    if (next === s.status) continue;
    await tx.update(schema.rentSchedules).set({ status: next }).where(eq(schema.rentSchedules.id, s.id));
    if (next === 'overdue') {
      overdue += 1;
      const recipients = await tx
        .select({ userId: schema.leaseParties.userId })
        .from(schema.leaseParties)
        .where(and(eq(schema.leaseParties.leaseId, lease.id), eq(schema.leaseParties.accessStatus, 'active')));
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
          recipientUserIds: recipients.map((p) => p.userId).filter(Boolean),
        },
        correlationId: null,
      });
    }
  }
  return overdue;
}

export interface RentRunSummary {
  invoiced: number;
  overdue: number;
  expiredInvitations: number;
}

export async function runRentJob(db: Database, now: Date = new Date(), correlationId?: string): Promise<RentRunSummary> {
  const asOf = today(now);
  const fa = systemFinanceActor(correlationId);
  return withActor(db, systemContext(correlationId ?? 'rent.generate_due_charges'), async (tx) => {
    const summary: RentRunSummary = { invoiced: 0, overdue: 0, expiredInvitations: 0 };
    const leases = await tx
      .select()
      .from(schema.leases)
      .where(inArray(schema.leases.status, ['active', 'expiring']));
    for (const lease of leases) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`lease:${lease.id}`}))`);
      if (await invoiceDeposit(tx, fa, lease, now)) summary.invoiced += 1;
      const schedules = await tx
        .select()
        .from(schema.rentSchedules)
        .where(eq(schema.rentSchedules.leaseId, lease.id))
        .orderBy(asc(schema.rentSchedules.dueDate));
      for (const s of periodsDueForInvoicing(schedules, asOf, INVOICE_LEAD_DAYS)) {
        try {
          if (await invoiceSchedule(tx, fa, s, lease, now)) summary.invoiced += 1;
        } catch (err) {
          if (err instanceof ApiError && err.code === 'conflict') continue;
          throw err;
        }
      }
      summary.overdue += await syncAllocations(tx, lease, asOf);
    }
    const expired = await tx
      .update(schema.leaseParties)
      .set({ accessStatus: 'expired', invitationTokenHash: null })
      .where(and(eq(schema.leaseParties.accessStatus, 'invited'), lt(schema.leaseParties.invitationExpiresAt, now)))
      .returning({ id: schema.leaseParties.id });
    summary.expiredInvitations = expired.length;
    return summary;
  });
}

export async function runSlaJob(db: Database, now: Date = new Date()): Promise<{ breached: number; recurring: number }> {
  return withActor(db, systemContext('work_orders.sla_check'), async (tx) => {
    let breached = 0;
    const open = await tx
      .select()
      .from(schema.workOrders)
      .where(and(lt(schema.workOrders.slaDueAt, now), inArray(schema.workOrders.status, [...OPEN_WORK])));
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
        after: { status: row.status, slaDueAt: row.slaDueAt?.toISOString() ?? null, priority: row.priority },
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
        .where(and(sql`${schema.assets.nextServiceAt} <= ${asOf}`, sql`${schema.assets.serviceIntervalDays} IS NOT NULL`));
      for (const asset of due) {
        const [openForAsset] = await tx
          .select({ id: schema.workOrders.id })
          .from(schema.workOrders)
          .where(and(eq(schema.workOrders.assetId, asset.id), inArray(schema.workOrders.status, [...OPEN_WORK])))
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
              recurring: { assetId: asset.id, intervalDays: asset.serviceIntervalDays, dueOn: asset.nextServiceAt },
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
    const summary = await runRentJob(db, new Date(), job.correlationId ?? undefined);
    if (summary.invoiced > 0 || summary.overdue > 0 || summary.expiredInvitations > 0)
      log.info(summary, 'rent invoicing run');
  });

  runner.register('work_orders.sla_check', async ({ db, log }) => {
    const summary = await runSlaJob(db);
    if (summary.breached > 0 || summary.recurring > 0) log.info(summary, 'work order SLA check');
  });
}
