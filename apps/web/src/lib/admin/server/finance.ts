import 'server-only';
import { and, asc, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type {
  BankTransferReceiptDto,
  CreditNoteDto,
  PaymentAttemptDto,
  ReceiptDto,
  RefundDto,
} from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import {
  exportAllocations,
  listReconciliationAttempts,
  listReconciliationExceptions,
  toBankReceiptDto,
  toCreditNoteDto,
  toPaymentAttemptDto,
  toRefundDto,
} from '@simplexd/finance';
import type { RequestIdentity } from '@/lib/auth/session';
import { sumKobo } from '../money';
import { can, financeFor, iso, orgNames, requireAnyStaff, staffTx, userNames } from './context';

export interface FinanceOverview {
  invoices: Record<string, number>;
  receiptsPendingReview: number;
  refundsRequested: number;
  attemptsUncertain: number;
  openExceptions: number;
  journalCount: number;
  payoutsPending: number;
  permissions: {
    manageInvoices: boolean;
    reconcile: boolean;
    approveRefunds: boolean;
    requestRefunds: boolean;
    exportAllowed: boolean;
    payouts: boolean;
  };
}

export async function financeOverview(identity: RequestIdentity): Promise<FinanceOverview> {
  requireAnyStaff(identity, ['finance.read']);
  return staffTx(identity, async (tx) => {
    const invoices = await tx
      .select({ status: schema.invoices.status, n: count() })
      .from(schema.invoices)
      .groupBy(schema.invoices.status);
    const [receipts] = await tx
      .select({ n: count() })
      .from(schema.bankTransferReceipts)
      .where(inArray(schema.bankTransferReceipts.status, ['submitted', 'under_review']));
    const [refunds] = await tx
      .select({ n: count() })
      .from(schema.refunds)
      .where(eq(schema.refunds.status, 'requested'));
    const [uncertain] = await tx
      .select({ n: count() })
      .from(schema.paymentAttempts)
      .where(inArray(schema.paymentAttempts.status, ['uncertain', 'pending']));
    const [exceptions] = await tx
      .select({ n: count() })
      .from(schema.reconciliations)
      .where(inArray(schema.reconciliations.status, ['exceptions', 'open', 'in_progress']));
    const [journals] = await tx.select({ n: count() }).from(schema.journals);
    const [payouts] = await tx
      .select({ n: count() })
      .from(schema.payouts)
      .where(inArray(schema.payouts.status, ['proposed', 'first_approved']));
    const byStatus: Record<string, number> = {};
    for (const i of invoices) byStatus[i.status] = Number(i.n);
    return {
      invoices: byStatus,
      receiptsPendingReview: Number(receipts?.n ?? 0),
      refundsRequested: Number(refunds?.n ?? 0),
      attemptsUncertain: Number(uncertain?.n ?? 0),
      openExceptions: Number(exceptions?.n ?? 0),
      journalCount: Number(journals?.n ?? 0),
      payoutsPending: Number(payouts?.n ?? 0),
      permissions: {
        manageInvoices: can(identity, 'finance.invoices.manage'),
        reconcile: can(identity, 'finance.reconcile'),
        approveRefunds: can(identity, 'finance.refunds.approve'),
        requestRefunds: can(identity, 'finance.refunds.request'),
        exportAllowed: can(identity, 'finance.export'),
        payouts: can(identity, 'finance.payouts.first_approve') || can(identity, 'finance.payouts.second_approve'),
      },
    };
  });
}

export interface RefundRow extends RefundDto {
  invoiceNumber: string | null;
  organizationName: string;
  requestedByName: string | null;
  approvedByName: string | null;
}

export async function listRefunds(
  identity: RequestIdentity,
  filters: { status?: string; limit: number },
): Promise<RefundRow[]> {
  requireAnyStaff(identity, ['finance.read']);
  return staffTx(identity, async (tx) => {
    const rows = await tx
      .select({ r: schema.refunds, invoiceNumber: schema.invoices.number })
      .from(schema.refunds)
      .leftJoin(schema.invoices, eq(schema.invoices.id, schema.refunds.invoiceId))
      .where(filters.status ? eq(schema.refunds.status, filters.status as never) : undefined)
      .orderBy(desc(schema.refunds.createdAt))
      .limit(filters.limit);
    const names = await userNames(
      tx,
      rows.flatMap((r) => [r.r.requestedBy, r.r.approvedBy]),
    );
    const orgs = await orgNames(
      tx,
      rows.map((r) => r.r.organizationId),
    );
    return rows.map((r) => ({
      ...toRefundDto(r.r),
      invoiceNumber: r.invoiceNumber ?? null,
      organizationName: orgs.get(r.r.organizationId) ?? r.r.organizationId,
      requestedByName: r.r.requestedBy ? (names.get(r.r.requestedBy)?.name ?? null) : null,
      approvedByName: r.r.approvedBy ? (names.get(r.r.approvedBy)?.name ?? null) : null,
    }));
  });
}

export interface BankReceiptRow extends BankTransferReceiptDto {
  invoiceNumber: string | null;
  invoiceBalanceKobo: string | null;
  invoiceStatus: string | null;
  organizationName: string;
  submittedByName: string | null;
}

export async function listBankReceipts(
  identity: RequestIdentity,
  filters: { status?: string; limit: number },
): Promise<BankReceiptRow[]> {
  requireAnyStaff(identity, ['finance.read']);
  return staffTx(identity, async (tx) => {
    const rows = await tx
      .select({
        r: schema.bankTransferReceipts,
        invoiceNumber: schema.invoices.number,
        invoiceStatus: schema.invoices.status,
        totalKobo: schema.invoices.totalKobo,
        paidKobo: schema.invoices.amountPaidKobo,
        creditedKobo: schema.invoices.amountCreditedKobo,
      })
      .from(schema.bankTransferReceipts)
      .leftJoin(schema.invoices, eq(schema.invoices.id, schema.bankTransferReceipts.invoiceId))
      .where(
        filters.status
          ? eq(schema.bankTransferReceipts.status, filters.status as never)
          : inArray(schema.bankTransferReceipts.status, ['submitted', 'under_review']),
      )
      .orderBy(asc(schema.bankTransferReceipts.createdAt))
      .limit(filters.limit);
    const names = await userNames(
      tx,
      rows.map((r) => r.r.submittedBy),
    );
    const orgs = await orgNames(
      tx,
      rows.map((r) => r.r.organizationId),
    );
    return rows.map((r) => ({
      ...toBankReceiptDto(r.r),
      invoiceNumber: r.invoiceNumber ?? null,
      invoiceStatus: r.invoiceStatus ?? null,
      invoiceBalanceKobo:
        r.totalKobo !== null && r.totalKobo !== undefined
          ? (
              BigInt(r.totalKobo) -
              BigInt(r.paidKobo ?? 0) -
              BigInt(r.creditedKobo ?? 0)
            ).toString()
          : null,
      organizationName: orgs.get(r.r.organizationId) ?? r.r.organizationId,
      submittedByName: r.r.submittedBy ? (names.get(r.r.submittedBy)?.name ?? null) : null,
    }));
  });
}

export interface CreditNoteRow extends CreditNoteDto {
  invoiceNumber: string | null;
  organizationName: string;
}

export async function listCreditNotes(identity: RequestIdentity, limit = 100): Promise<CreditNoteRow[]> {
  requireAnyStaff(identity, ['finance.read']);
  return staffTx(identity, async (tx) => {
    const rows = await tx
      .select({ c: schema.creditNotes, invoiceNumber: schema.invoices.number })
      .from(schema.creditNotes)
      .leftJoin(schema.invoices, eq(schema.invoices.id, schema.creditNotes.invoiceId))
      .orderBy(desc(schema.creditNotes.createdAt))
      .limit(limit);
    const orgs = await orgNames(
      tx,
      rows.map((r) => r.c.organizationId),
    );
    return rows.map((r) => ({
      ...toCreditNoteDto(r.c),
      invoiceNumber: r.invoiceNumber ?? null,
      organizationName: orgs.get(r.c.organizationId) ?? r.c.organizationId,
    }));
  });
}

export interface ReceiptRow extends ReceiptDto {
  organizationName: string;
}

export async function listReceipts(identity: RequestIdentity, limit = 100): Promise<ReceiptRow[]> {
  requireAnyStaff(identity, ['finance.read']);
  return staffTx(identity, async (tx) => {
    const rows = await tx
      .select({
        r: schema.receipts,
        invoiceNumber: schema.invoices.number,
        currency: schema.invoices.currency,
        source: schema.allocations.paymentAttemptId,
        bank: schema.allocations.bankReceiptId,
        credit: schema.allocations.creditNoteId,
      })
      .from(schema.receipts)
      .leftJoin(schema.invoices, eq(schema.invoices.id, schema.receipts.invoiceId))
      .leftJoin(schema.allocations, eq(schema.allocations.id, schema.receipts.allocationId))
      .orderBy(desc(schema.receipts.issuedAt))
      .limit(limit);
    const orgs = await orgNames(
      tx,
      rows.map((r) => r.r.organizationId),
    );
    return rows.map((r) => ({
      id: r.r.id,
      number: r.r.number,
      invoiceId: r.r.invoiceId,
      invoiceNumber: r.invoiceNumber ?? '',
      organizationId: r.r.organizationId,
      allocationId: r.r.allocationId,
      amountKobo: r.r.amountKobo.toString(),
      currency: r.currency ?? 'NGN',
      source: r.bank ? 'bank_transfer' : r.credit ? 'credit_note' : 'gateway',
      issuedAt: r.r.issuedAt.toISOString(),
      organizationName: orgs.get(r.r.organizationId) ?? r.r.organizationId,
    }));
  });
}

export interface LedgerAccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  normalBalance: string;
  isControl: boolean;
  description: string | null;
  active: boolean;
  debitKobo: string;
  creditKobo: string;
  balanceKobo: string;
}

/** Chart of accounts with posted totals (read-only). */
export async function listLedgerAccounts(identity: RequestIdentity): Promise<LedgerAccountRow[]> {
  requireAnyStaff(identity, ['finance.read']);
  return staffTx(identity, async (tx) => {
    const accounts = await tx.select().from(schema.ledgerAccounts).orderBy(asc(schema.ledgerAccounts.code));
    const totals = await tx
      .select({
        accountId: schema.journalLines.accountId,
        debit: sql<string>`coalesce(sum(${schema.journalLines.debitKobo}), 0)::text`,
        credit: sql<string>`coalesce(sum(${schema.journalLines.creditKobo}), 0)::text`,
      })
      .from(schema.journalLines)
      .groupBy(schema.journalLines.accountId);
    const byAccount = new Map(totals.map((t) => [t.accountId, t]));
    return accounts.map((a) => {
      const t = byAccount.get(a.id);
      const debit = BigInt(t?.debit ?? '0');
      const credit = BigInt(t?.credit ?? '0');
      const balance = a.normalBalance === 'debit' ? debit - credit : credit - debit;
      return {
        id: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        subtype: a.subtype ?? null,
        normalBalance: a.normalBalance,
        isControl: Boolean(a.isControl),
        description: a.description ?? null,
        active: Boolean(a.active),
        debitKobo: debit.toString(),
        creditKobo: credit.toString(),
        balanceKobo: balance.toString(),
      };
    });
  });
}

export interface JournalRow {
  id: string;
  organizationId: string | null;
  organizationName: string | null;
  businessEventRef: string;
  description: string | null;
  sourceType: string | null;
  sourceId: string | null;
  postedAt: string;
  postedByName: string | null;
  reversalOfJournalId: string | null;
  lines: Array<{
    lineNo: number;
    accountCode: string;
    accountName: string;
    debitKobo: string;
    creditKobo: string;
    memo: string | null;
    entityType: string | null;
    entityId: string | null;
  }>;
  balanced: boolean;
}

/** Read-only journal browser with balanced-check per journal. */
export async function listJournals(
  identity: RequestIdentity,
  filters: { organizationId?: string; sourceType?: string; page: number; pageSize: number },
): Promise<{ items: JournalRow[]; total: number }> {
  requireAnyStaff(identity, ['finance.read']);
  return staffTx(identity, async (tx) => {
    const where = and(
      filters.organizationId ? eq(schema.journals.organizationId, filters.organizationId) : undefined,
      filters.sourceType ? eq(schema.journals.sourceType, filters.sourceType) : undefined,
    );
    const [totalRow] = await tx.select({ n: count() }).from(schema.journals).where(where);
    const journals = await tx
      .select()
      .from(schema.journals)
      .where(where)
      .orderBy(desc(schema.journals.postedAt), desc(schema.journals.id))
      .limit(filters.pageSize)
      .offset((filters.page - 1) * filters.pageSize);
    const ids = journals.map((j) => j.id);
    const lines = ids.length
      ? await tx
          .select({
            l: schema.journalLines,
            code: schema.ledgerAccounts.code,
            name: schema.ledgerAccounts.name,
          })
          .from(schema.journalLines)
          .innerJoin(schema.ledgerAccounts, eq(schema.ledgerAccounts.id, schema.journalLines.accountId))
          .where(inArray(schema.journalLines.journalId, ids))
          .orderBy(asc(schema.journalLines.journalId), asc(schema.journalLines.lineNo))
      : [];
    const names = await userNames(
      tx,
      journals.map((j) => j.postedBy),
    );
    const orgs = await orgNames(
      tx,
      journals.map((j) => j.organizationId),
    );
    const byJournal = new Map<string, JournalRow['lines']>();
    for (const row of lines) {
      const list = byJournal.get(row.l.journalId) ?? [];
      list.push({
        lineNo: row.l.lineNo,
        accountCode: row.code,
        accountName: row.name,
        debitKobo: row.l.debitKobo.toString(),
        creditKobo: row.l.creditKobo.toString(),
        memo: row.l.memo ?? null,
        entityType: row.l.entityType ?? null,
        entityId: row.l.entityId ?? null,
      });
      byJournal.set(row.l.journalId, list);
    }
    return {
      total: Number(totalRow?.n ?? 0),
      items: journals.map((j) => {
        const jl = byJournal.get(j.id) ?? [];
        const debit = sumKobo(jl.map((l) => l.debitKobo));
        const credit = sumKobo(jl.map((l) => l.creditKobo));
        return {
          id: j.id,
          organizationId: j.organizationId ?? null,
          organizationName: j.organizationId ? (orgs.get(j.organizationId) ?? null) : null,
          businessEventRef: j.businessEventRef,
          description: j.description ?? null,
          sourceType: j.sourceType ?? null,
          sourceId: j.sourceId ?? null,
          postedAt: j.postedAt.toISOString(),
          postedByName: j.postedBy ? (names.get(j.postedBy)?.name ?? null) : null,
          reversalOfJournalId: j.reversalOfJournalId ?? null,
          lines: jl,
          balanced: debit === credit,
        };
      }),
    };
  });
}

export interface PayoutRow {
  id: string;
  organizationId: string;
  organizationName: string;
  kind: string;
  amountKobo: string;
  currency: string;
  status: string;
  beneficiary: unknown;
  ownerStatementId: string | null;
  proposedByName: string | null;
  firstApproverName: string | null;
  secondApproverName: string | null;
  submittedAt: string | null;
  settledAt: string | null;
  failureReason: string | null;
}

export async function listPayouts(identity: RequestIdentity, limit = 100): Promise<PayoutRow[]> {
  requireAnyStaff(identity, ['finance.read']);
  return staffTx(identity, async (tx) => {
    const rows = await tx.select().from(schema.payouts).orderBy(desc(schema.payouts.createdAt)).limit(limit);
    const names = await userNames(
      tx,
      rows.flatMap((r) => [r.proposedBy, r.firstApproverId, r.secondApproverId]),
    );
    const orgs = await orgNames(
      tx,
      rows.map((r) => r.organizationId),
    );
    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      organizationName: orgs.get(r.organizationId) ?? r.organizationId,
      kind: r.kind,
      amountKobo: r.amountKobo.toString(),
      currency: r.currency,
      status: r.status,
      beneficiary: r.beneficiary ?? null,
      ownerStatementId: r.ownerStatementId ?? null,
      proposedByName: r.proposedBy ? (names.get(r.proposedBy)?.name ?? null) : null,
      firstApproverName: r.firstApproverId ? (names.get(r.firstApproverId)?.name ?? null) : null,
      secondApproverName: r.secondApproverId ? (names.get(r.secondApproverId)?.name ?? null) : null,
      submittedAt: iso(r.submittedAt),
      settledAt: iso(r.settledAt),
      failureReason: r.failureReason ?? null,
    }));
  });
}

/** Reconciliation queue: attempts awaiting verification plus exceptions (needs `finance.reconcile`). */
export async function reconciliationView(identity: RequestIdentity, filters: { status?: string }) {
  const { rt, fa } = financeFor(identity);
  const [attempts, exceptions] = await Promise.all([
    listReconciliationAttempts(rt, fa, {
      status: filters.status as PaymentAttemptDto['status'] | undefined,
      limit: 100,
    }),
    listReconciliationExceptions(rt, fa, { limit: 100 }),
  ]);
  return { attempts, exceptions };
}

/** Payment attempts for an invoice (staff finance.read). */
export async function listInvoiceAttempts(identity: RequestIdentity, invoiceId: string) {
  requireAnyStaff(identity, ['finance.read']);
  return staffTx(identity, async (tx) => {
    const attempts = await tx
      .select()
      .from(schema.paymentAttempts)
      .where(eq(schema.paymentAttempts.invoiceId, invoiceId))
      .orderBy(desc(schema.paymentAttempts.createdAt));
    const receipts = await tx
      .select()
      .from(schema.bankTransferReceipts)
      .where(eq(schema.bankTransferReceipts.invoiceId, invoiceId))
      .orderBy(desc(schema.bankTransferReceipts.createdAt));
    const refunds = await tx
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.invoiceId, invoiceId))
      .orderBy(desc(schema.refunds.createdAt));
    const credits = await tx
      .select()
      .from(schema.creditNotes)
      .where(eq(schema.creditNotes.invoiceId, invoiceId))
      .orderBy(desc(schema.creditNotes.createdAt));
    return {
      attempts: attempts.map(toPaymentAttemptDto),
      bankReceipts: receipts.map(toBankReceiptDto),
      refunds: refunds.map(toRefundDto),
      creditNotes: credits.map(toCreditNoteDto),
    };
  });
}

export interface AllocationsReconciliation {
  rows: Array<Record<string, unknown>>;
  totalAllocatedKobo: string;
  receiptsTotalKobo: string;
  receiptsCount: number;
  allocationsCount: number;
  reconciles: boolean;
}

/**
 * Allocation export preview plus an independent receipts total over the same
 * window so finance can see that the export reconciles to underlying records.
 */
export async function allocationsReconciliation(
  identity: RequestIdentity,
  query: { from?: string; to?: string; organizationId?: string },
): Promise<AllocationsReconciliation> {
  const { rt, fa } = financeFor(identity);
  const rows = await exportAllocations(rt, fa, query);
  const totals = await staffTx(identity, async (tx) => {
    const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : null;
    const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : null;
    const [r] = await tx
      .select({
        n: count(),
        total: sql<string>`coalesce(sum(${schema.receipts.amountKobo}), 0)::text`,
      })
      .from(schema.receipts)
      .where(
        and(
          from ? gte(schema.receipts.issuedAt, from) : undefined,
          to ? lte(schema.receipts.issuedAt, to) : undefined,
          query.organizationId ? eq(schema.receipts.organizationId, query.organizationId) : undefined,
        ),
      );
    return { n: Number(r?.n ?? 0), total: r?.total ?? '0' };
  });
  const allocated = sumKobo(rows.map((r) => String(r.amountKobo ?? r.amount_kobo ?? '0')));
  return {
    rows,
    totalAllocatedKobo: allocated,
    receiptsTotalKobo: totals.total,
    receiptsCount: totals.n,
    allocationsCount: rows.length,
    reconciles: BigInt(allocated) === BigInt(totals.total),
  };
}
