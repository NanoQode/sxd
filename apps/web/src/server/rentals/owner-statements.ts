import 'server-only';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type OwnerStatementDto,
  type OwnerStatementGenerate,
  type OwnerStatementListQuery,
  type Page,
  type StatementLineDto,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { findJournalByRef, postJournal } from '@simplexd/finance';
import { assertAllowed, authorizeAny, type ResourceRef } from '@simplexd/domain/authz';
import {
  ACCOUNTS,
  credit,
  debit,
  maintenanceExpenseRecovered,
  managementFeeFromCollectedRent,
  type JournalDraft,
} from '@simplexd/domain/ledger';
import {
  ageArrears,
  computeStatementTotals,
  leaseManagementFee,
  monthsInPeriod,
  stayGross,
  type StatementLine,
} from '@simplexd/domain/rentals';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { isFeatureEnabled } from '@/lib/features';
import { loadCharges, syncRentAllocations } from './schedules';
import {
  FEATURES,
  ctxFor,
  decodeCursor,
  elevated,
  encodeCursor,
  isStaffIdentity,
  iso,
  requireUserId,
  resolveOrganization,
  type LeaseRow,
  type ServiceOptions,
} from './shared';

/**
 * Owner statements: for an owner organisation (optionally one property or
 * estate) and a period, the rent and service charges actually collected
 * (settled money allocations mirrored into `rent_allocations`; credit notes
 * are not collections), the agreed
 * management fee per lease, verified maintenance recoveries, arrears and
 * open obligations. Reconciling posts the fee and recovery journals and
 * proves the statement totals against finance allocations and journal
 * lines; only a reconciled statement can back a payout.
 */

type StatementRow = typeof schema.ownerStatements.$inferSelect;

interface StoredLines {
  lines: StatementLineDto[];
  reconciliation: OwnerStatementDto['reconciliation'];
  reconciliationId: string | null;
  workOrderIds: string[];
  leaseIds: string[];
}

function statementRef(organizationId: string, id?: string): ResourceRef {
  return { type: 'owner_statement', id, organizationId };
}

function assertManage(identity: RequestIdentity, ref: ResourceRef): void {
  assertAllowed(authorizeAny(identity.actor, [{ staff: 'rentals.manage' }], ref));
}

function assertRead(identity: RequestIdentity, ref: ResourceRef): void {
  assertAllowed(
    authorizeAny(
      identity.actor,
      [{ staff: 'rentals.manage' }, { staff: 'finance.read' }, { org: 'org.read' }],
      ref,
    ),
  );
}

function stored(row: StatementRow): StoredLines {
  const raw = (row.lines as Partial<StoredLines> | null) ?? {};
  return {
    lines: raw.lines ?? [],
    reconciliation: raw.reconciliation ?? null,
    reconciliationId: raw.reconciliationId ?? null,
    workOrderIds: raw.workOrderIds ?? [],
    leaseIds: raw.leaseIds ?? [],
  };
}

export function toStatementDto(row: StatementRow): OwnerStatementDto {
  const s = stored(row);
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    estateId: row.estateId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status,
    totals: row.totals ?? {
      collectedKobo: '0',
      feesKobo: '0',
      expensesKobo: '0',
      netKobo: '0',
      arrearsKobo: '0',
      openObligations: [],
    },
    lines: s.lines,
    reconciliation: s.reconciliation,
    generatedAt: row.generatedAt.toISOString(),
    reconciledBy: row.reconciledBy,
    reconciledAt: iso(row.reconciledAt),
    issuedAt: iso(row.issuedAt),
  };
}

function lineToDto(l: StatementLine): StatementLineDto {
  return {
    kind: l.kind,
    description: l.description,
    amountKobo: l.amountKobo.toString(),
    leaseId: l.leaseId ?? null,
    workOrderId: l.workOrderId ?? null,
    allocationId: l.allocationId ?? null,
    invoiceId: l.invoiceId ?? null,
    stayBookingId: l.stayBookingId ?? null,
    feeBps: l.feeBps ?? null,
  };
}

async function leasesInScope(
  tx: DbExecutor,
  scope: { organizationId: string; propertyId: string | null; estateId: string | null },
): Promise<LeaseRow[]> {
  const propertyIds = scope.estateId
    ? (
        await tx
          .select({ id: schema.properties.id })
          .from(schema.properties)
          .where(eq(schema.properties.estateId, scope.estateId))
      ).map((p) => p.id)
    : null;
  if (propertyIds && propertyIds.length === 0) return [];
  return tx
    .select()
    .from(schema.leases)
    .where(
      and(
        eq(schema.leases.organizationId, scope.organizationId),
        scope.propertyId ? eq(schema.leases.propertyId, scope.propertyId) : undefined,
        propertyIds ? inArray(schema.leases.propertyId, propertyIds) : undefined,
      ),
    );
}

/** Settled allocations on the scope's leases inside the period (finance truth), with the charge kinds they paid. */
async function collectedLines(
  tx: DbExecutor,
  leases: LeaseRow[],
  periodStart: string,
  periodEnd: string,
): Promise<StatementLine[]> {
  if (leases.length === 0) return [];
  const periodEndExclusive = new Date(Date.parse(`${periodEnd}T00:00:00.000Z`) + 86_400_000);
  const rows = await tx
    .select({
      leaseId: schema.rentAllocations.leaseId,
      amountKobo: schema.rentAllocations.amountKobo,
      allocationId: schema.rentAllocations.allocationId,
      kind: schema.rentCharges.kind,
      description: schema.rentCharges.description,
      invoiceId: schema.rentCharges.invoiceId,
      allocatedAt: schema.allocations.allocatedAt,
    })
    .from(schema.rentAllocations)
    .innerJoin(schema.rentCharges, eq(schema.rentCharges.id, schema.rentAllocations.rentChargeId))
    .innerJoin(schema.allocations, eq(schema.allocations.id, schema.rentAllocations.allocationId))
    .where(
      and(
        inArray(
          schema.rentAllocations.leaseId,
          leases.map((l) => l.id),
        ),
        gte(schema.allocations.allocatedAt, new Date(`${periodStart}T00:00:00.000Z`)),
        lt(schema.allocations.allocatedAt, periodEndExclusive),
        // Credit notes settle a charge without money changing hands: not collected.
        isNull(schema.allocations.creditNoteId),
        sql`${schema.rentCharges.kind} <> 'deposit'`,
      ),
    );
  return rows.map((r) => ({
    kind: r.kind === 'service_charge' ? 'service_charge_collected' : 'rent_collected',
    description: `${r.description} (collected ${r.allocatedAt.toISOString().slice(0, 10)})`,
    amountKobo: r.amountKobo,
    leaseId: r.leaseId,
    allocationId: r.allocationId,
    invoiceId: r.invoiceId,
  }));
}

async function feeLines(
  tx: DbExecutor,
  leases: LeaseRow[],
  collected: StatementLine[],
  periodStart: string,
  periodEnd: string,
): Promise<StatementLine[]> {
  const months = monthsInPeriod(periodStart, periodEnd);
  const out: StatementLine[] = [];
  for (const lease of leases) {
    const leaseCollected = collected
      .filter((c) => c.leaseId === lease.id && c.kind === 'rent_collected')
      .reduce((s, c) => s + c.amountKobo, 0n);
    const fee = leaseManagementFee(
      {
        basis: lease.managementFeeBasis,
        feeBps: lease.managementFeeBps,
        fixedKobo: lease.managementFeeFixedKobo,
      },
      leaseCollected,
      ['active', 'expiring'].includes(lease.status) ? months : 0,
    );
    if (fee <= 0n) continue;
    out.push({
      kind: 'management_fee',
      description:
        lease.managementFeeBasis === 'percentage_of_collected'
          ? `Management fee ${lease.managementFeeBps} bps of ${leaseCollected} kobo collected`
          : `Fixed management fee (${months} month${months === 1 ? '' : 's'})`,
      amountKobo: fee,
      leaseId: lease.id,
      feeBps:
        lease.managementFeeBasis === 'percentage_of_collected' ? lease.managementFeeBps : null,
    });
  }
  return out;
}

/** Verified work orders in scope (verified on or before the period end) whose expense has not been recovered from the owner yet. */
async function recoveryLines(
  tx: DbExecutor,
  scope: { organizationId: string; propertyId: string | null; estateId: string | null },
  periodEnd: string,
  statementId: string | null,
): Promise<{ lines: StatementLine[]; workOrderIds: string[] }> {
  const rows = await tx
    .select()
    .from(schema.workOrders)
    .where(
      and(
        eq(schema.workOrders.organizationId, scope.organizationId),
        scope.propertyId ? eq(schema.workOrders.propertyId, scope.propertyId) : undefined,
        scope.estateId ? eq(schema.workOrders.estateId, scope.estateId) : undefined,
        inArray(schema.workOrders.status, ['verified', 'closed']),
        isNotNull(schema.workOrders.expenseJournalId),
        lte(schema.workOrders.verifiedAt, new Date(`${periodEnd}T23:59:59.999Z`)),
      ),
    );
  const lines: StatementLine[] = [];
  const ids: string[] = [];
  for (const wo of rows) {
    const recovered = await findJournalByRef(tx, `work_order:${wo.id}:recovered`);
    if (recovered) {
      const [j] = await tx
        .select({ sourceId: schema.journals.sourceId, description: schema.journals.description })
        .from(schema.journals)
        .where(eq(schema.journals.id, recovered.id));
      // Recovered by an earlier statement: not this one's line.
      if (!statementId || !j?.description.includes(statementId)) continue;
    }
    const amount = wo.actualCostKobo ?? wo.approvedAmountKobo ?? 0n;
    if (amount <= 0n) continue;
    lines.push({
      kind: 'maintenance_recovery',
      description: `Maintenance: ${wo.title}`,
      amountKobo: amount,
      workOrderId: wo.id,
      leaseId: wo.leaseId,
    });
    ids.push(wo.id);
  }
  return { lines, workOrderIds: ids };
}

async function arrearsLines(
  tx: DbExecutor,
  leases: LeaseRow[],
  periodEnd: string,
): Promise<StatementLine[]> {
  const out: StatementLine[] = [];
  for (const lease of leases) {
    const charges = (await loadCharges(tx, lease.id)).filter(
      (c) => c.kind !== 'deposit' && c.chargedAt <= periodEnd,
    );
    const allocations = await tx
      .select({
        rentChargeId: schema.rentAllocations.rentChargeId,
        amountKobo: schema.rentAllocations.amountKobo,
      })
      .from(schema.rentAllocations)
      .where(eq(schema.rentAllocations.leaseId, lease.id));
    const ageing = ageArrears(charges, allocations, periodEnd);
    if (ageing.totalOutstandingKobo > 0n)
      out.push({
        kind: 'arrears',
        description: `Outstanding on lease ${lease.id.slice(0, 8)} as of ${periodEnd}`,
        amountKobo: ageing.totalOutstandingKobo,
        leaseId: lease.id,
      });
  }
  return out;
}

async function shortStayLines(
  tx: DbExecutor,
  scope: { organizationId: string; propertyId: string | null },
  periodStart: string,
  periodEnd: string,
): Promise<StatementLine[]> {
  const rows = await tx
    .select()
    .from(schema.stayBookings)
    .where(
      and(
        eq(schema.stayBookings.organizationId, scope.organizationId),
        scope.propertyId ? eq(schema.stayBookings.propertyId, scope.propertyId) : undefined,
        eq(schema.stayBookings.status, 'checked_out'),
        gte(schema.stayBookings.checkOut, periodStart),
        lte(schema.stayBookings.checkOut, periodEnd),
      ),
    );
  const out: StatementLine[] = [];
  for (const b of rows) {
    out.push({
      kind: 'short_stay_income',
      description: `Stay ${b.guestName} ${b.checkIn} to ${b.checkOut} (${b.nights} nights)`,
      amountKobo: stayGross(b.nights, b.nightlyRateKobo),
      stayBookingId: b.id,
    });
    const expense = b.platformFeeKobo + b.cleaningKobo;
    if (expense > 0n)
      out.push({
        kind: 'short_stay_expense',
        description: `Stay costs (platform fee + cleaning) for ${b.guestName}`,
        amountKobo: expense,
        stayBookingId: b.id,
      });
  }
  return out;
}

export async function generateOwnerStatement(
  identity: RequestIdentity,
  input: OwnerStatementGenerate,
  options: ServiceOptions = {},
): Promise<OwnerStatementDto> {
  requireUserId(identity);
  if (input.periodEnd < input.periodStart)
    throw new ApiError('validation_failed', 'periodEnd is before periodStart');
  if (input.estateId && !isFeatureEnabled(identity, FEATURES.estateManagement))
    throw new ApiError('feature_disabled', 'estate statements need estate management', {
      details: { feature: FEATURES.estateManagement },
    });
  const organizationId = resolveOrganization(identity, input.organizationId);
  assertManage(identity, statementRef(organizationId));
  const scope = {
    organizationId,
    propertyId: input.propertyId ?? null,
    estateId: input.estateId ?? null,
  };
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const leases = await leasesInScope(tx, scope);
    await syncRentAllocations(
      tx,
      leases.map((l) => l.id),
      input.periodEnd,
    );
    const [existing] = await tx
      .select()
      .from(schema.ownerStatements)
      .where(
        and(
          eq(schema.ownerStatements.organizationId, organizationId),
          scope.propertyId
            ? eq(schema.ownerStatements.propertyId, scope.propertyId)
            : sql`${schema.ownerStatements.propertyId} IS NULL`,
          scope.estateId
            ? eq(schema.ownerStatements.estateId, scope.estateId)
            : sql`${schema.ownerStatements.estateId} IS NULL`,
          eq(schema.ownerStatements.periodStart, input.periodStart),
          eq(schema.ownerStatements.periodEnd, input.periodEnd),
        ),
      );
    if (existing && existing.status !== 'draft')
      throw new ApiError(
        'conflict',
        `a ${existing.status} statement already exists for this period`,
        { details: { statementId: existing.id } },
      );
    const collected = await collectedLines(tx, leases, input.periodStart, input.periodEnd);
    const fees = await feeLines(tx, leases, collected, input.periodStart, input.periodEnd);
    const recoveries = await recoveryLines(tx, scope, input.periodEnd, existing?.id ?? null);
    const arrears = await arrearsLines(tx, leases, input.periodEnd);
    const stays = isFeatureEnabled(identity, FEATURES.shortStay)
      ? await shortStayLines(tx, scope, input.periodStart, input.periodEnd)
      : [];
    const lines = [...collected, ...fees, ...recoveries.lines, ...arrears, ...stays];
    const totals = computeStatementTotals(lines);
    const openWork = await tx
      .select({
        id: schema.workOrders.id,
        title: schema.workOrders.title,
        estimate: schema.workOrders.estimateKobo,
        approved: schema.workOrders.approvedAmountKobo,
      })
      .from(schema.workOrders)
      .where(
        and(
          eq(schema.workOrders.organizationId, organizationId),
          scope.propertyId ? eq(schema.workOrders.propertyId, scope.propertyId) : undefined,
          inArray(schema.workOrders.status, [
            'approved',
            'in_progress',
            'completed',
            'awaiting_approval',
          ]),
        ),
      );
    const openObligations = [
      ...arrears.map((a) => ({ description: a.description, amountKobo: a.amountKobo.toString() })),
      ...openWork.map((w) => ({
        description: `Open work: ${w.title}`,
        amountKobo: (w.approved ?? w.estimate ?? 0n).toString(),
      })),
    ];
    const totalsJson = {
      collectedKobo: totals.collectedKobo.toString(),
      feesKobo: totals.feesKobo.toString(),
      expensesKobo: totals.expensesKobo.toString(),
      netKobo: totals.netKobo.toString(),
      arrearsKobo: totals.arrearsKobo.toString(),
      openObligations,
    };
    const linesJson: StoredLines = {
      lines: lines.map(lineToDto),
      reconciliation: null,
      reconciliationId: null,
      workOrderIds: recoveries.workOrderIds,
      leaseIds: leases.map((l) => l.id),
    };
    const [row] = existing
      ? await tx
          .update(schema.ownerStatements)
          .set({ totals: totalsJson, lines: linesJson, generatedAt: new Date() })
          .where(eq(schema.ownerStatements.id, existing.id))
          .returning()
      : await tx
          .insert(schema.ownerStatements)
          .values({
            organizationId,
            propertyId: scope.propertyId,
            estateId: scope.estateId,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            status: 'draft',
            totals: totalsJson,
            lines: linesJson,
          })
          .returning();
    await recordAudit(tx, identity, {
      action: existing ? 'owner_statement.regenerated' : 'owner_statement.generated',
      entityType: 'owner_statement',
      entityId: row!.id,
      organizationId,
      after: {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        totals: totalsJson,
        leases: leases.length,
      },
      correlationId: options.correlationId,
    });
    return toStatementDto(row!);
  });
}

function feeDraft(
  statement: StatementRow,
  line: StatementLineDto,
  lease: LeaseRow,
  estateSegment: string | null,
): JournalDraft {
  const collected = stored(statement)
    .lines.filter((l) => l.leaseId === lease.id && l.kind === 'rent_collected')
    .reduce((s, l) => s + BigInt(l.amountKobo), 0n);
  if (line.feeBps) {
    const draft = managementFeeFromCollectedRent({
      statement: {
        id: statement.id,
        organizationId: statement.organizationId,
        ownerOrganizationId: statement.organizationId,
        period: `${statement.periodStart}..${statement.periodEnd}`,
      },
      collectedRentKobo: collected,
      feeBps: line.feeBps,
      estateSegment,
    });
    return { ...draft, businessEventRef: `${draft.businessEventRef}:${lease.id}` };
  }
  const amount = BigInt(line.amountKobo);
  const entity = { entityType: 'owner_statement', entityId: statement.id };
  return {
    businessEventRef: `owner_statement:${statement.id}:management_fee:${lease.id}`,
    description: `Fixed management fee for ${statement.periodStart}..${statement.periodEnd} (statement ${statement.id})`,
    sourceType: 'owner_statement',
    sourceId: statement.id,
    currency: lease.currency,
    organizationId: statement.organizationId,
    ...(estateSegment ? { estateSegment } : {}),
    lines: [
      debit(ACCOUNTS.RENT_COLLECTED_PAYABLE_TO_OWNERS, amount, {
        ...entity,
        memo: 'Fixed management fee deducted from rent payable',
        organizationId: statement.organizationId,
      }),
      credit(ACCOUNTS.MANAGEMENT_FEE_REVENUE, amount, {
        ...entity,
        memo: 'Fixed management fee earned',
      }),
    ],
  };
}

/**
 * Posts the fee and recovery journals (idempotent by business-event ref),
 * then recomputes the statement totals from finance allocations and journal
 * lines. The statement becomes `reconciled` only when every figure matches;
 * otherwise it stays a draft and the mismatch is returned as a conflict.
 */
export async function reconcileOwnerStatement(
  identity: RequestIdentity,
  id: string,
  options: ServiceOptions = {},
): Promise<OwnerStatementDto> {
  const userId = requireUserId(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.ownerStatements)
      .where(eq(schema.ownerStatements.id, id))
      .for('update');
    if (!row) throw new ApiError('not_found', 'statement not found');
    assertManage(identity, statementRef(row.organizationId, row.id));
    if (row.status !== 'draft') return toStatementDto(row);
    const s = stored(row);
    const leases =
      s.leaseIds.length > 0
        ? await tx.select().from(schema.leases).where(inArray(schema.leases.id, s.leaseIds))
        : [];
    const estateSegment = row.estateId
      ? ((
          await tx
            .select({ s: schema.estates.ledgerSegment })
            .from(schema.estates)
            .where(eq(schema.estates.id, row.estateId))
        )[0]?.s ?? null)
      : null;
    const workOrders =
      s.workOrderIds.length > 0
        ? await tx
            .select()
            .from(schema.workOrders)
            .where(inArray(schema.workOrders.id, s.workOrderIds))
        : [];

    const result = await elevated(tx, ctx, async () => {
      for (const line of s.lines.filter((l) => l.kind === 'management_fee')) {
        const lease = leases.find((l) => l.id === line.leaseId);
        if (!lease) continue;
        const draft = feeDraft(row, line, lease, estateSegment);
        if (!(await findJournalByRef(tx, draft.businessEventRef)))
          await postJournal(tx, draft, { postedBy: userId });
      }
      for (const wo of workOrders) {
        const line = s.lines.find((l) => l.workOrderId === wo.id);
        if (!line) continue;
        const draft = maintenanceExpenseRecovered({
          workOrder: {
            id: wo.id,
            organizationId: wo.organizationId,
            currency: 'NGN',
            ownerOrganizationId: wo.organizationId,
          },
          amountKobo: BigInt(line.amountKobo),
          estateSegment,
        });
        if (!(await findJournalByRef(tx, draft.businessEventRef))) {
          await postJournal(
            tx,
            { ...draft, description: `${draft.description} (statement ${row.id})` },
            { postedBy: userId },
          );
        }
      }
      // Independent recomputation from finance truth.
      const allocationsKobo =
        leases.length === 0
          ? 0n
          : BigInt(
              (
                await tx.execute<{ total: string }>(sql`
                  select coalesce(sum(a.amount_kobo), 0)::text as total
                  from allocations a
                  join invoices i on i.id = a.invoice_id
                  where i.lease_id in (${sql.join(
                    leases.map((l) => sql`${l.id}`),
                    sql`, `,
                  )})
                    and i.kind in ('rent','service_charge')
                    and a.credit_note_id is null
                    and a.allocated_at >= ${`${row.periodStart}T00:00:00Z`}::timestamptz
                    and a.allocated_at < (${`${row.periodEnd}T00:00:00Z`}::timestamptz + interval '1 day')
                `)
              ).rows[0]?.total ?? '0',
            );
      const feeJournalKobo = BigInt(
        (
          await tx.execute<{ total: string }>(sql`
            select coalesce(sum(jl.credit_kobo), 0)::text as total
            from journal_lines jl
            join journals j on j.id = jl.journal_id
            join ledger_accounts la on la.id = jl.account_id
            where j.source_type = 'owner_statement' and j.source_id = ${row.id} and la.code = ${ACCOUNTS.MANAGEMENT_FEE_REVENUE}
              and j.business_event_ref like ${`owner_statement:${row.id}:management_fee%`}
          `)
        ).rows[0]?.total ?? '0',
      );
      const recoveryJournalKobo =
        workOrders.length === 0
          ? 0n
          : BigInt(
              (
                await tx.execute<{ total: string }>(sql`
                  select coalesce(sum(jl.debit_kobo), 0)::text as total
                  from journal_lines jl
                  join journals j on j.id = jl.journal_id
                  join ledger_accounts la on la.id = jl.account_id
                  where la.code = ${ACCOUNTS.RENT_COLLECTED_PAYABLE_TO_OWNERS}
                    and j.business_event_ref in (${sql.join(
                      workOrders.map((w) => sql`${`work_order:${w.id}:recovered`}`),
                      sql`, `,
                    )})
                `)
              ).rows[0]?.total ?? '0',
            );
      return { allocationsKobo, feeJournalKobo, recoveryJournalKobo };
    });

    const totals = row.totals!;
    const matches =
      result.allocationsKobo === BigInt(totals.collectedKobo) &&
      result.feeJournalKobo === BigInt(totals.feesKobo) &&
      result.recoveryJournalKobo === BigInt(totals.expensesKobo);
    const reconciliation = {
      allocationsKobo: result.allocationsKobo.toString(),
      feeJournalKobo: result.feeJournalKobo.toString(),
      recoveryJournalKobo: result.recoveryJournalKobo.toString(),
      matches,
    };
    if (!matches) {
      await tx
        .update(schema.ownerStatements)
        .set({ lines: { ...s, reconciliation } })
        .where(eq(schema.ownerStatements.id, id));
      throw new ApiError(
        'conflict',
        'statement totals do not match the ledger; regenerate the statement',
        { details: { totals, reconciliation } },
      );
    }
    const reconciliationId = await elevated(tx, ctx, async () => {
      const [rec] = await tx
        .insert(schema.reconciliations)
        .values({
          kind: 'owner_statement',
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          status: 'balanced',
          summary: { ownerStatementId: row.id, ...reconciliation },
          exceptions: [],
          performedBy: userId,
          closedAt: new Date(),
        })
        .returning({ id: schema.reconciliations.id });
      return rec!.id;
    });
    const [updated] = await tx
      .update(schema.ownerStatements)
      .set({
        status: 'reconciled',
        reconciledBy: userId,
        reconciledAt: new Date(),
        lines: { ...s, reconciliation, reconciliationId },
      })
      .where(eq(schema.ownerStatements.id, id))
      .returning();
    await recordAudit(tx, identity, {
      action: 'owner_statement.reconciled',
      entityType: 'owner_statement',
      entityId: id,
      organizationId: row.organizationId,
      after: { reconciliation, reconciliationId },
      correlationId: options.correlationId,
    });
    return toStatementDto(updated!);
  });
}

export async function issueOwnerStatement(
  identity: RequestIdentity,
  id: string,
  options: ServiceOptions = {},
): Promise<OwnerStatementDto> {
  const userId = requireUserId(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.ownerStatements)
      .where(eq(schema.ownerStatements.id, id))
      .for('update');
    if (!row) throw new ApiError('not_found', 'statement not found');
    assertManage(identity, statementRef(row.organizationId, row.id));
    if (row.status !== 'reconciled')
      throw new ApiError(
        'invalid_transition',
        `only reconciled statements are issued (statement is ${row.status})`,
      );
    const [updated] = await tx
      .update(schema.ownerStatements)
      .set({ status: 'issued', issuedAt: new Date() })
      .where(eq(schema.ownerStatements.id, id))
      .returning();
    await recordAudit(tx, identity, {
      action: 'owner_statement.issued',
      entityType: 'owner_statement',
      entityId: id,
      organizationId: row.organizationId,
      correlationId: options.correlationId,
    });
    const members = await tx
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, row.organizationId));
    await appendOutbox(tx, {
      eventType: 'owner_statement.issued',
      aggregateType: 'owner_statement',
      aggregateId: id,
      organizationId: row.organizationId,
      actorUserId: userId,
      payload: {
        statementId: id,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        netKobo: row.totals?.netKobo ?? '0',
        recipientUserIds: members.map((m) => m.userId),
      },
      correlationId: options.correlationId ?? null,
    });
    return toStatementDto(updated!);
  });
}

export async function getOwnerStatement(
  identity: RequestIdentity,
  id: string,
): Promise<OwnerStatementDto> {
  requireUserId(identity);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.ownerStatements)
      .where(eq(schema.ownerStatements.id, id));
    if (!row) throw new ApiError('not_found', 'statement not found');
    assertRead(identity, statementRef(row.organizationId, row.id));
    // Owners see reconciled or issued statements; drafts are staff working copies.
    if (!isStaffIdentity(identity) && row.status === 'draft')
      throw new ApiError('not_found', 'statement not found');
    return toStatementDto(row);
  });
}

export async function listOwnerStatements(
  identity: RequestIdentity,
  query: OwnerStatementListQuery,
): Promise<Page<OwnerStatementDto>> {
  requireUserId(identity);
  const staff = isStaffIdentity(identity);
  const orgId = staff ? (query.organizationId ?? null) : identity.ctx.organizationId;
  if (!staff && !orgId) return { items: [], nextCursor: null };
  if (orgId) assertRead(identity, statementRef(orgId));
  const cursor = decodeCursor(query.cursor);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.ownerStatements)
      .where(
        and(
          orgId ? eq(schema.ownerStatements.organizationId, orgId) : undefined,
          query.propertyId ? eq(schema.ownerStatements.propertyId, query.propertyId) : undefined,
          query.status ? eq(schema.ownerStatements.status, query.status) : undefined,
          !staff ? inArray(schema.ownerStatements.status, ['reconciled', 'issued']) : undefined,
          cursor
            ? or(
                lt(schema.ownerStatements.generatedAt, cursor.createdAt),
                and(
                  eq(schema.ownerStatements.generatedAt, cursor.createdAt),
                  lt(schema.ownerStatements.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.ownerStatements.generatedAt), desc(schema.ownerStatements.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return {
      items: page.map(toStatementDto),
      nextCursor: last ? encodeCursor(last.generatedAt, last.id) : null,
    };
  });
}

/** Statement row loader for the payout module. */
export async function loadStatementForPayout(
  tx: DbExecutor,
  id: string,
): Promise<{ row: StatementRow; reconciliationId: string | null }> {
  const [row] = await tx
    .select()
    .from(schema.ownerStatements)
    .where(eq(schema.ownerStatements.id, id));
  if (!row) throw new ApiError('not_found', 'statement not found');
  return { row, reconciliationId: stored(row).reconciliationId };
}
