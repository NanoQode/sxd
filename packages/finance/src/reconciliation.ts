import { and, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import type { AllocationsExportQuery, PaymentAttemptDto, ReconciliationExceptionDto } from '@simplexd/contracts';
import { schema, withActor } from '@simplexd/db';
import { assertStaff, systemFinanceActor, type FinanceActor } from './actor';
import { recordAudit } from './audit';
import { expireQuotes } from './engagements/quotes';
import { toPaymentAttemptDto, verifyAttemptAsSystem } from './payment-attempts';
import { pollPendingRefunds } from './refunds';
import { RECONCILIATION_KIND, addReconciliationException, openReconciliationForDay } from './reconciliation-exceptions';
import type { FinanceRuntime } from './runtime';

export const RECONCILE_AFTER_SECONDS = 10 * 60;

export interface ReconcileSummary {
  reverified: number;
  settled: number;
  exceptions: number;
  refundsPolled: number;
  quotesExpired: number;
  reconciliationId: string;
}

/**
 * Scheduled `payments.reconcile_pending`: re-verifies pending/uncertain
 * attempts older than ten minutes with the same matcher every other path
 * uses, polls refunds still in flight, expires stale quotes and keeps the
 * day's reconciliation row current. Nothing here settles without the
 * provider confirming the exact attempt.
 */
export async function reconcilePending(rt: FinanceRuntime, options: { correlationId?: string } = {}): Promise<ReconcileSummary> {
  const system = systemFinanceActor(options.correlationId);
  const now = rt.now();
  const cutoff = new Date(now.getTime() - RECONCILE_AFTER_SECONDS * 1000);
  const attempts = await withActor(rt.db, system.ctx, (tx) =>
    tx
      .select()
      .from(schema.paymentAttempts)
      .where(and(sql`${schema.paymentAttempts.status} in ('initialized','pending','uncertain')`, lt(schema.paymentAttempts.createdAt, cutoff), sql`${schema.paymentAttempts.provider} <> 'bank_transfer'`))
      .orderBy(schema.paymentAttempts.createdAt)
      .limit(200),
  );
  let reverified = 0;
  let settled = 0;
  let exceptions = 0;
  for (const attempt of attempts) {
    try {
      const result = await verifyAttemptAsSystem(rt, attempt.reference, { source: 'reconcile', correlationId: options.correlationId });
      reverified += 1;
      if (result.outcome.decision === 'settle') settled += 1;
      if (result.outcome.decision === 'mismatch' || result.outcome.decision === 'mark_uncertain') exceptions += 1;
    } catch (err) {
      exceptions += 1;
      await withActor(rt.db, system.ctx, (tx) =>
        addReconciliationException(tx, { code: 'reverify_failed', message: `${attempt.reference}: ${err instanceof Error ? err.message : 'unknown error'}`, entityType: 'payment_attempt', entityId: attempt.id }, now),
      );
    }
  }
  const refundsPolled = await pollPendingRefunds(rt, options);
  const quotesExpired = (await expireQuotes(rt, now)).length;
  const reconciliationId = await withActor(rt.db, system.ctx, async (tx) => {
    const row = await openReconciliationForDay(tx, now.toISOString().slice(0, 10));
    const [pending] = await tx
      .select({ n: sql<string>`count(*)::text` })
      .from(schema.paymentAttempts)
      .where(sql`${schema.paymentAttempts.status} in ('initialized','pending','uncertain')`);
    const summary = {
      ...((row.summary as Record<string, unknown> | null) ?? {}),
      lastRunAt: now.toISOString(),
      reverified,
      settled,
      pendingAttempts: Number(pending?.n ?? 0),
      refundsPolled,
      quotesExpired,
    };
    const exceptionCount = (row.exceptions ?? []).length;
    await tx
      .update(schema.reconciliations)
      .set({ summary, status: exceptionCount > 0 ? 'exceptions' : Number(pending?.n ?? 0) > 0 ? 'in_progress' : 'balanced' })
      .where(eq(schema.reconciliations.id, row.id));
    await recordAudit(tx, system, { action: 'reconciliation.run', entityType: 'reconciliation', entityId: row.id, after: summary, actorType: 'job' });
    return row.id;
  });
  return { reverified, settled, exceptions, refundsPolled, quotesExpired, reconciliationId };
}

export async function listReconciliationAttempts(
  rt: FinanceRuntime,
  fa: FinanceActor,
  query: { status?: PaymentAttemptDto['status']; environment?: 'test' | 'live'; limit: number },
): Promise<PaymentAttemptDto[]> {
  assertStaff(fa, 'finance.reconcile');
  const rows = await withActor(rt.db, fa.ctx, (tx) =>
    tx
      .select()
      .from(schema.paymentAttempts)
      .where(
        and(
          query.status ? eq(schema.paymentAttempts.status, query.status) : sql`${schema.paymentAttempts.status} in ('initialized','pending','uncertain','reversed')`,
          query.environment ? eq(schema.paymentAttempts.environment, query.environment) : undefined,
        ),
      )
      .orderBy(desc(schema.paymentAttempts.createdAt))
      .limit(query.limit),
  );
  return rows.map(toPaymentAttemptDto);
}

export async function listReconciliationExceptions(rt: FinanceRuntime, fa: FinanceActor, options: { limit: number }): Promise<ReconciliationExceptionDto[]> {
  assertStaff(fa, 'finance.reconcile');
  const rows = await withActor(rt.db, fa.ctx, (tx) =>
    tx
      .select()
      .from(schema.reconciliations)
      .where(eq(schema.reconciliations.kind, RECONCILIATION_KIND))
      .orderBy(desc(schema.reconciliations.periodStart))
      .limit(options.limit),
  );
  const out: ReconciliationExceptionDto[] = [];
  for (const row of rows) {
    for (const e of row.exceptions ?? []) {
      out.push({ reconciliationId: row.id, periodStart: row.periodStart, status: row.status, code: e.code, message: e.message, entityType: e.entityType ?? null, entityId: e.entityId ?? null });
    }
  }
  return out;
}

export interface AllocationExportRow extends Record<string, unknown> {
  allocationId: string;
  allocatedAt: string;
  organizationId: string;
  invoiceId: string;
  invoiceNumber: string;
  source: 'gateway' | 'bank_transfer' | 'credit_note';
  sourceId: string;
  reference: string;
  amountKobo: string;
  currency: string;
  receiptNumber: string;
  journalId: string;
  journalRef: string;
  journalDebitKobo: string;
  journalCreditKobo: string;
}

/**
 * Export (`finance.export`) that reconciles to allocations: one row per
 * allocation with its receipt and the journal's debit/credit totals, so an
 * accountant can tie the ledger to the invoices without any provider detail.
 */
export async function exportAllocations(rt: FinanceRuntime, fa: FinanceActor, query: AllocationsExportQuery): Promise<AllocationExportRow[]> {
  assertStaff(fa, 'finance.export');
  const rows = await withActor(rt.db, fa.ctx, (tx) =>
    tx
      .select({
        allocation: schema.allocations,
        invoiceNumber: schema.invoices.number,
        attemptReference: schema.paymentAttempts.reference,
        bankReference: schema.bankTransferReceipts.bankReference,
        creditNoteNumber: schema.creditNotes.number,
        receiptNumber: schema.receipts.number,
        journalRef: schema.journals.businessEventRef,
      })
      .from(schema.allocations)
      .innerJoin(schema.invoices, eq(schema.invoices.id, schema.allocations.invoiceId))
      .leftJoin(schema.paymentAttempts, eq(schema.paymentAttempts.id, schema.allocations.paymentAttemptId))
      .leftJoin(schema.bankTransferReceipts, eq(schema.bankTransferReceipts.id, schema.allocations.bankReceiptId))
      .leftJoin(schema.creditNotes, eq(schema.creditNotes.id, schema.allocations.creditNoteId))
      .leftJoin(schema.receipts, eq(schema.receipts.allocationId, schema.allocations.id))
      .leftJoin(schema.journals, eq(schema.journals.id, schema.allocations.journalId))
      .where(
        and(
          query.from ? gte(schema.allocations.allocatedAt, new Date(`${query.from}T00:00:00Z`)) : undefined,
          query.to ? lte(schema.allocations.allocatedAt, new Date(`${query.to}T23:59:59.999Z`)) : undefined,
          query.organizationId ? eq(schema.allocations.organizationId, query.organizationId) : undefined,
        ),
      )
      .orderBy(schema.allocations.allocatedAt)
      .limit(50_000),
  );
  const journalIds = [...new Set(rows.map((r) => r.allocation.journalId).filter((v): v is string => Boolean(v)))];
  const totals = new Map<string, { d: string; c: string }>();
  if (journalIds.length > 0) {
    const agg = await withActor(rt.db, fa.ctx, (tx) =>
      tx
        .select({ journalId: schema.journalLines.journalId, d: sql<string>`sum(${schema.journalLines.debitKobo})::text`, c: sql<string>`sum(${schema.journalLines.creditKobo})::text` })
        .from(schema.journalLines)
        .where(sql`${schema.journalLines.journalId} = ANY(${sql.raw(`ARRAY[${journalIds.map((id) => `'${id}'`).join(',')}]::uuid[]`)})`)
        .groupBy(schema.journalLines.journalId),
    );
    for (const a of agg) totals.set(a.journalId, { d: a.d, c: a.c });
  }
  await withActor(rt.db, fa.ctx, (tx) =>
    recordAudit(tx, fa, { action: 'finance.export', entityType: 'allocations', after: { rows: rows.length, ...query } }),
  );
  return rows.map((r) => {
    const a = r.allocation;
    const source = a.paymentAttemptId ? 'gateway' : a.bankReceiptId ? 'bank_transfer' : 'credit_note';
    const t = a.journalId ? totals.get(a.journalId) : undefined;
    return {
      allocationId: a.id,
      allocatedAt: a.allocatedAt.toISOString(),
      organizationId: a.organizationId,
      invoiceId: a.invoiceId,
      invoiceNumber: r.invoiceNumber,
      source,
      sourceId: a.paymentAttemptId ?? a.bankReceiptId ?? a.creditNoteId ?? '',
      reference: r.attemptReference ?? r.bankReference ?? r.creditNoteNumber ?? '',
      amountKobo: a.amountKobo.toString(),
      currency: a.currency,
      receiptNumber: r.receiptNumber ?? '',
      journalId: a.journalId ?? '',
      journalRef: r.journalRef ?? '',
      journalDebitKobo: t?.d ?? '',
      journalCreditKobo: t?.c ?? '',
    };
  });
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const columns = Object.keys(rows[0]!);
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
