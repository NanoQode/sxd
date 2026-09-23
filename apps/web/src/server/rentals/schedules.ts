import 'server-only';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type ArrearsDto,
  type LeaseBalanceDto,
  type LeaseTermsDto,
  type RentChargeCreate,
  type RentChargeDto,
  type RentScheduleDto,
} from '@simplexd/contracts';
import {
  appendOutbox,
  getDb,
  schema,
  withActor,
  type DbExecutor,
  type Transaction,
} from '@simplexd/db';
import { createInvoiceRecord, issueInvoiceTx, type FinanceActor } from '@simplexd/finance';
import {
  addDays,
  ageArrears,
  apportionAllocation,
  compareDates,
  daysOverdue,
  generateRentSchedule,
  outstandingByCharge,
  scheduleStatusFor,
  type AcademicTerm,
} from '@simplexd/domain/rentals';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  ctxFor,
  elevated,
  requireLease,
  requireUserId,
  today,
  type LeaseRow,
  type ServiceOptions,
} from './shared';

/**
 * Rent schedules and charges. Activation generates the periods from the lease
 * terms (pure domain function); the hourly job turns due periods into `rent`
 * invoices collected on the owner's behalf; settled money on those invoices
 * is mirrored into `rent_allocations` so charge balances, arrears ageing and
 * owner statements all read from the same figures as the ledger. Charges of
 * waived periods (termination, renewal) are no longer owed and are left out
 * of balances, arrears and statements.
 */

type ScheduleRow = typeof schema.rentSchedules.$inferSelect;
type ChargeRow = typeof schema.rentCharges.$inferSelect;

export const DEFAULT_INVOICE_LEAD_DAYS = 14;

export function toScheduleDto(s: ScheduleRow): RentScheduleDto {
  return {
    id: s.id,
    leaseId: s.leaseId,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    dueDate: s.dueDate,
    amountKobo: s.amountKobo.toString(),
    status: s.status,
    invoiceId: s.invoiceId,
    createdAt: s.createdAt.toISOString(),
  };
}

export function toChargeDto(c: ChargeRow, paidKobo: bigint): RentChargeDto {
  const outstanding = c.amountKobo - paidKobo;
  return {
    id: c.id,
    leaseId: c.leaseId,
    scheduleId: c.scheduleId,
    kind: c.kind,
    description: c.description,
    amountKobo: c.amountKobo.toString(),
    chargedAt: c.chargedAt,
    invoiceId: c.invoiceId,
    estateId: c.estateId,
    paidKobo: paidKobo.toString(),
    outstandingKobo: (outstanding > 0n ? outstanding : 0n).toString(),
    createdAt: c.createdAt.toISOString(),
  };
}

/* ---------------------------------------------------------------------- */
/* Generation                                                              */
/* ---------------------------------------------------------------------- */

function periodLabel(
  kind: LeaseRow['rentPeriod'],
  start: string,
  end: string,
  label: string | null,
): string {
  if (label) return `Rent — ${label} (${start} to ${end})`;
  return `${kind === 'monthly' ? 'Monthly' : kind === 'quarterly' ? 'Quarterly' : 'Annual'} rent ${start} to ${end}`;
}

/**
 * Inserts the schedule and its rent/service-charge charges for a lease.
 * Idempotent: periods already present (unique on lease + period start) are
 * kept, so re-activating or regenerating never duplicates a charge.
 */
export async function generateScheduleForLease(
  tx: DbExecutor,
  lease: LeaseRow,
  terms: Partial<LeaseTermsDto> | null,
  createdBy: string | null,
): Promise<{ created: number; skipped: number }> {
  const academicTerms: AcademicTerm[] | undefined = terms?.academicTerms?.map((t) => ({
    label: t.label,
    start: t.start,
    end: t.end,
    ...(t.amountKobo ? { amountKobo: BigInt(t.amountKobo) } : {}),
  }));
  const periods = generateRentSchedule({
    startDate: lease.startDate,
    endDate: lease.endDate,
    rentAmountKobo: lease.rentAmountKobo,
    rentPeriod: lease.rentPeriod,
    dueLeadDays: terms?.dueLeadDays ?? 0,
    prorate: terms?.prorate ?? true,
    ...(academicTerms ? { academicTerms } : {}),
  });
  const serviceCharge = terms?.serviceChargeKobo ? BigInt(terms.serviceChargeKobo) : 0n;
  const [property] = await tx
    .select({ estateId: schema.properties.estateId })
    .from(schema.properties)
    .where(eq(schema.properties.id, lease.propertyId));
  const estateId = property?.estateId ?? null;
  let created = 0;
  let skipped = 0;
  for (const p of periods) {
    const inserted = await tx
      .insert(schema.rentSchedules)
      .values({
        leaseId: lease.id,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        dueDate: p.dueDate,
        amountKobo: p.amountKobo + serviceCharge,
      })
      .onConflictDoNothing()
      .returning({ id: schema.rentSchedules.id });
    const schedule = inserted[0];
    if (!schedule) {
      skipped += 1;
      continue;
    }
    created += 1;
    await tx.insert(schema.rentCharges).values({
      leaseId: lease.id,
      scheduleId: schedule.id,
      kind: 'rent',
      description: p.proration
        ? `${periodLabel(lease.rentPeriod, p.periodStart, p.periodEnd, p.label)} (prorated ${p.proration.days}/${p.proration.ofDays} days)`
        : periodLabel(lease.rentPeriod, p.periodStart, p.periodEnd, p.label),
      amountKobo: p.amountKobo,
      chargedAt: p.dueDate,
      createdBy,
    });
    if (serviceCharge > 0n) {
      await tx.insert(schema.rentCharges).values({
        leaseId: lease.id,
        scheduleId: schedule.id,
        kind: 'service_charge',
        description: `Service charge ${p.periodStart} to ${p.periodEnd}`,
        amountKobo: serviceCharge,
        chargedAt: p.dueDate,
        estateId,
        createdBy,
      });
    }
  }
  if (lease.depositKobo > 0n) {
    const [existing] = await tx
      .select({ id: schema.rentCharges.id })
      .from(schema.rentCharges)
      .where(and(eq(schema.rentCharges.leaseId, lease.id), eq(schema.rentCharges.kind, 'deposit')))
      .limit(1);
    if (!existing) {
      await tx.insert(schema.rentCharges).values({
        leaseId: lease.id,
        kind: 'deposit',
        description: 'Security deposit',
        amountKobo: lease.depositKobo,
        chargedAt: lease.startDate,
        createdBy,
      });
    }
  }
  return { created, skipped };
}

/* ---------------------------------------------------------------------- */
/* Reads                                                                   */
/* ---------------------------------------------------------------------- */

/** Charges still owed or paid on a lease, oldest first; charges of waived periods are left out. */
export async function loadCharges(tx: DbExecutor, leaseId: string): Promise<ChargeRow[]> {
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

export async function loadPaidByCharge(
  tx: DbExecutor,
  leaseId: string,
): Promise<Map<string, bigint>> {
  const rows = await tx
    .select({
      rentChargeId: schema.rentAllocations.rentChargeId,
      amountKobo: schema.rentAllocations.amountKobo,
    })
    .from(schema.rentAllocations)
    .where(eq(schema.rentAllocations.leaseId, leaseId));
  const out = new Map<string, bigint>();
  for (const r of rows) out.set(r.rentChargeId, (out.get(r.rentChargeId) ?? 0n) + r.amountKobo);
  return out;
}

export async function listSchedule(
  identity: RequestIdentity,
  leaseId: string,
): Promise<RentScheduleDto[]> {
  return withActor(getDb(), identity.ctx, async (tx) => {
    await requireLease(tx, identity, leaseId, 'read', 'tenant.balances.view');
    const rows = await tx
      .select()
      .from(schema.rentSchedules)
      .where(eq(schema.rentSchedules.leaseId, leaseId))
      .orderBy(asc(schema.rentSchedules.periodStart));
    return rows.map(toScheduleDto);
  });
}

export async function listCharges(
  identity: RequestIdentity,
  leaseId: string,
): Promise<RentChargeDto[]> {
  return withActor(getDb(), identity.ctx, async (tx) => {
    await requireLease(tx, identity, leaseId, 'read', 'tenant.balances.view');
    await refreshLeaseAllocations(tx, identity, leaseId);
    return chargesWithBalances(tx, leaseId);
  });
}

export async function chargesWithBalances(
  tx: DbExecutor,
  leaseId: string,
): Promise<RentChargeDto[]> {
  const [charges, paid] = await Promise.all([
    loadCharges(tx, leaseId),
    loadPaidByCharge(tx, leaseId),
  ]);
  return charges.map((c) => toChargeDto(c, paid.get(c.id) ?? 0n));
}

/** Ad-hoc charge (late fee, utility, other) raised by the owner or staff; picked up by the next rent invoice. */
export async function addCharge(
  identity: RequestIdentity,
  leaseId: string,
  input: RentChargeCreate,
  options: ServiceOptions = {},
): Promise<RentChargeDto> {
  const userId = requireUserId(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { lease } = await requireLease(tx, identity, leaseId, 'manage');
    if (!['active', 'expiring'].includes(lease.status))
      throw new ApiError(
        'invalid_transition',
        `charges can only be raised on an active lease (lease is ${lease.status})`,
      );
    const [row] = await tx
      .insert(schema.rentCharges)
      .values({
        leaseId,
        kind: input.kind,
        description: input.description,
        amountKobo: BigInt(input.amountKobo),
        chargedAt: input.chargedAt ?? today(),
        createdBy: userId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'rent_charge.created',
      entityType: 'rent_charge',
      entityId: row!.id,
      organizationId: lease.organizationId,
      after: { leaseId, kind: input.kind, amountKobo: input.amountKobo },
      correlationId: options.correlationId,
    });
    return toChargeDto(row!, 0n);
  });
}

/* ---------------------------------------------------------------------- */
/* Balances and arrears                                                    */
/* ---------------------------------------------------------------------- */

export async function computeLeaseBalance(
  tx: DbExecutor,
  lease: LeaseRow,
  asOf: string,
): Promise<LeaseBalanceDto> {
  const charges = await loadCharges(tx, lease.id);
  const allocations = await tx
    .select({
      rentChargeId: schema.rentAllocations.rentChargeId,
      amountKobo: schema.rentAllocations.amountKobo,
    })
    .from(schema.rentAllocations)
    .where(eq(schema.rentAllocations.leaseId, lease.id));
  const schedules = await tx
    .select()
    .from(schema.rentSchedules)
    .where(eq(schema.rentSchedules.leaseId, lease.id))
    .orderBy(asc(schema.rentSchedules.dueDate));
  const dueByschedule = new Map(schedules.map((s) => [s.id, s.dueDate]));
  const nonDeposit = charges.filter((c) => c.kind !== 'deposit');
  const ageing = ageArrears(
    nonDeposit.map((c) => ({
      id: c.id,
      amountKobo: c.amountKobo,
      chargedAt: c.chargedAt,
      dueDate: c.scheduleId ? (dueByschedule.get(c.scheduleId) ?? c.chargedAt) : c.chargedAt,
    })),
    allocations,
    asOf,
  );
  const outstanding = outstandingByCharge(nonDeposit, allocations);
  let charged = 0n;
  let paid = 0n;
  for (const c of nonDeposit) {
    charged += c.amountKobo;
    paid += c.amountKobo - (outstanding.get(c.id) ?? 0n);
  }
  const depositPaid = charges
    .filter((c) => c.kind === 'deposit')
    .reduce(
      (sum, c) =>
        sum +
        allocations.filter((a) => a.rentChargeId === c.id).reduce((s, a) => s + a.amountKobo, 0n),
      0n,
    );
  const next =
    schedules.find(
      (s) =>
        ['scheduled', 'invoiced', 'partially_paid', 'overdue'].includes(s.status) &&
        compareDates(s.dueDate, asOf) >= 0,
    ) ??
    schedules.find((s) => ['invoiced', 'partially_paid', 'overdue'].includes(s.status)) ??
    null;
  const arrears: ArrearsDto = {
    asOf,
    buckets: Object.fromEntries(
      Object.entries(ageing.buckets).map(([k, v]) => [k, v.toString()]),
    ) as ArrearsDto['buckets'],
    totalOutstandingKobo: ageing.totalOutstandingKobo.toString(),
    items: ageing.items.map((i) => ({ ...i, outstandingKobo: i.outstandingKobo.toString() })),
  };
  return {
    leaseId: lease.id,
    currency: lease.currency,
    chargedKobo: charged.toString(),
    paidKobo: paid.toString(),
    outstandingKobo: ageing.totalOutstandingKobo.toString(),
    depositHeldKobo: depositPaid.toString(),
    nextDue: next
      ? { dueDate: next.dueDate, amountKobo: next.amountKobo.toString(), invoiceId: next.invoiceId }
      : null,
    arrears,
  };
}

/**
 * Brings the lease's mirrored allocations up to date before a balance read.
 * The caller has already been authorised for the lease; the mirror is a
 * system reconciliation, so it runs elevated (a tenant does not see every
 * allocation on the lease's invoices, and never writes finance rows).
 */
export async function refreshLeaseAllocations(
  tx: Transaction,
  identity: RequestIdentity,
  leaseId: string,
): Promise<void> {
  await elevated(tx, identity.ctx, () => syncRentAllocations(tx, [leaseId]));
}

export async function getLeaseBalance(
  identity: RequestIdentity,
  leaseId: string,
): Promise<LeaseBalanceDto> {
  return withActor(getDb(), identity.ctx, async (tx) => {
    const { lease } = await requireLease(tx, identity, leaseId, 'read', 'tenant.balances.view');
    await refreshLeaseAllocations(tx, identity, lease.id);
    return computeLeaseBalance(tx, lease, today());
  });
}

/* ---------------------------------------------------------------------- */
/* Invoicing (system job)                                                  */
/* ---------------------------------------------------------------------- */

async function estateSegmentFor(tx: DbExecutor, propertyId: string): Promise<string | null> {
  const [row] = await tx
    .select({ segment: schema.estates.ledgerSegment })
    .from(schema.properties)
    .innerJoin(schema.estates, eq(schema.estates.id, schema.properties.estateId))
    .where(eq(schema.properties.id, propertyId));
  return row?.segment ?? null;
}

async function primaryTenantUserId(tx: DbExecutor, leaseId: string): Promise<string | null> {
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

/**
 * Issues one `rent` invoice for a due schedule (rent + service charge of the
 * period plus any uninvoiced ad-hoc charges of the lease). The invoice is
 * marked as collected on behalf of the owner organisation, carries the
 * estate ledger segment when the property sits in an estate, and is issued
 * through @simplexd/finance so the receivable/owner-liability journal is
 * posted once. Runs under the system context.
 */
export async function invoiceScheduleTx(
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
  const estateSegment = await estateSegmentFor(tx, lease.propertyId);
  const draft = await createInvoiceRecord(tx, fa, {
    organizationId: lease.organizationId,
    customerUserId: await primaryTenantUserId(tx, lease.id),
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
      // The owner is the invoice's organisation (the lease's organisation). `ownerOrganizationId`
      // stays null until the domain `invoiceIssued` posting stops writing that text id into
      // `journal_lines.entity_id` (uuid), which currently fails the issue journal.
      ownerOrganizationId: null,
      estateSegment,
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

/** Deposit charge → `deposit` invoice (held funds, not owner rent). */
export async function invoiceDepositTx(
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
    customerUserId: await primaryTenantUserId(tx, lease.id),
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

/* ---------------------------------------------------------------------- */
/* Allocation mirroring                                                    */
/* ---------------------------------------------------------------------- */

/**
 * Mirrors finance allocations (settled gateway payments, confirmed bank
 * transfers, applied credit notes) on lease invoices into `rent_allocations`,
 * apportioning each allocation across the invoice's charges oldest first
 * (`apportionAllocation`). Then refreshes schedule statuses
 * (`scheduleStatusFor`) and emits a `rent.overdue` late notice the first time
 * a period turns overdue. Safe to re-run: an allocation already mirrored is
 * skipped. Runs under a privileged context (job, or elevated by the caller).
 */
export async function syncRentAllocations(
  tx: DbExecutor,
  leaseIds: string[],
  asOf: string = today(),
): Promise<{ mirrored: number; overdue: number }> {
  let mirrored = 0;
  let overdue = 0;
  for (const leaseId of leaseIds) {
    const invoices = await tx
      .select({ id: schema.invoices.id })
      .from(schema.invoices)
      .where(eq(schema.invoices.leaseId, leaseId));
    if (invoices.length === 0) continue;
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
          .where(eq(schema.rentAllocations.leaseId, leaseId))
      ).map((r) => r.allocationId),
    );
    const charges = await loadCharges(tx, leaseId);
    const paid = await loadPaidByCharge(tx, leaseId);
    for (const a of allocations) {
      if (existing.has(a.id)) continue;
      const parts = apportionAllocation(
        a.amountKobo,
        charges.filter((c) => c.invoiceId === a.invoiceId),
        paid,
      );
      for (const part of parts) {
        await tx.insert(schema.rentAllocations).values({
          leaseId,
          rentChargeId: part.chargeId,
          allocationId: a.id,
          amountKobo: part.amountKobo,
          allocatedBy: a.allocatedBy && a.allocatedBy !== 'system' ? a.allocatedBy : null,
          journalId: a.journalId,
        });
        paid.set(part.chargeId, (paid.get(part.chargeId) ?? 0n) + part.amountKobo);
        mirrored += 1;
      }
      existing.add(a.id);
    }
    const schedules = await tx
      .select()
      .from(schema.rentSchedules)
      .where(eq(schema.rentSchedules.leaseId, leaseId));
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
      const [lease] = await tx
        .select({ organizationId: schema.leases.organizationId })
        .from(schema.leases)
        .where(eq(schema.leases.id, leaseId));
      const recipients = await tx
        .select({ userId: schema.leaseParties.userId })
        .from(schema.leaseParties)
        .where(
          and(
            eq(schema.leaseParties.leaseId, leaseId),
            eq(schema.leaseParties.accessStatus, 'active'),
          ),
        );
      await appendOutbox(tx, {
        eventType: 'rent.overdue',
        aggregateType: 'lease',
        aggregateId: leaseId,
        organizationId: lease?.organizationId ?? null,
        actorUserId: null,
        payload: {
          leaseId,
          scheduleId: s.id,
          invoiceId: s.invoiceId,
          dueDate: s.dueDate,
          outstandingKobo: (total - settled).toString(),
          daysOverdue: daysOverdue(s.dueDate, asOf),
          recipientUserIds: recipients.map((p) => p.userId).filter(Boolean),
        },
        correlationId: null,
      });
    }
  }
  return { mirrored, overdue };
}

/** Next invoicing window end for display: today + lead days. */
export function invoicingCutoff(
  asOf: string = today(),
  leadDays: number = DEFAULT_INVOICE_LEAD_DAYS,
): string {
  return addDays(asOf, leadDays);
}
