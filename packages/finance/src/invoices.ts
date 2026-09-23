import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type Installment,
  type InvoiceCreate,
  type InvoiceDto,
  type InvoiceListQuery,
  type Page,
} from '@simplexd/contracts';
import { schema, withActor, type Transaction } from '@simplexd/db';
import { invoiceBalance, invoiceIssued, reverse, type InvoiceKind } from '@simplexd/domain/ledger';
import { evaluateTransition, invoiceMachine } from '@simplexd/domain/workflow';
import {
  assertStaff,
  assertStaffOrOrg,
  elevated,
  systemFinanceActor,
  type FinanceActor,
} from './actor';
import { emitEvent, recordAudit } from './audit';
import { findJournalByRef, postJournal } from './journal';
import { computeTotals, iso, loadTaxTreatment, type LineInput } from './money';
import { nextDocumentNumber } from './numbering';
import type { FinanceRuntime } from './runtime';

export type InvoiceRow = typeof schema.invoices.$inferSelect;
export type InvoiceLineRow = typeof schema.invoiceLines.$inferSelect;

export interface InvoiceRecordInput {
  organizationId: string;
  customerUserId: string | null;
  kind: InvoiceKind;
  serviceRequestId?: string | null;
  projectId?: string | null;
  milestoneId?: string | null;
  quoteVersionId?: string | null;
  lines: LineInput[];
  currency: string;
  taxTreatmentKey?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  installmentPlan?: Installment[] | null;
  createdBy?: string | null;
}

export function invoiceLineDto(l: InvoiceLineRow) {
  return {
    id: l.id,
    description: l.description,
    quantity: l.quantity,
    unitAmountKobo: l.unitAmountKobo.toString(),
    amountKobo: l.amountKobo.toString(),
    taxRateBps: l.taxRateBps,
    taxKobo: l.taxKobo.toString(),
    accountCode: l.accountCode,
  };
}

export function toInvoiceDto(inv: InvoiceRow, lines: InvoiceLineRow[]): InvoiceDto {
  return {
    id: inv.id,
    number: inv.number,
    organizationId: inv.organizationId,
    kind: inv.kind,
    status: inv.status,
    serviceRequestId: inv.serviceRequestId,
    quoteVersionId: inv.quoteVersionId,
    customerUserId: inv.customerUserId,
    currency: inv.currency,
    subtotalKobo: inv.subtotalKobo.toString(),
    taxKobo: inv.taxKobo.toString(),
    withholdingKobo: inv.withholdingKobo.toString(),
    totalKobo: inv.totalKobo.toString(),
    amountPaidKobo: inv.amountPaidKobo.toString(),
    amountCreditedKobo: inv.amountCreditedKobo.toString(),
    balanceKobo: invoiceBalance(inv).toString(),
    taxTreatmentKey: inv.taxTreatmentKey,
    dueDate: inv.dueDate,
    issuedAt: iso(inv.issuedAt),
    paidAt: iso(inv.paidAt),
    voidedAt: iso(inv.voidedAt),
    voidReason: inv.voidReason,
    notes: inv.notes,
    installmentPlan: (inv.installmentPlan as Installment[] | null) ?? null,
    lines: lines.map(invoiceLineDto),
    version: inv.version,
    createdAt: inv.createdAt.toISOString(),
    updatedAt: inv.updatedAt.toISOString(),
  };
}

export async function loadInvoiceLines(
  tx: Transaction,
  invoiceId: string,
): Promise<InvoiceLineRow[]> {
  return tx
    .select()
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, invoiceId))
    .orderBy(asc(schema.invoiceLines.sortOrder), asc(schema.invoiceLines.id));
}

export async function loadInvoiceForUpdate(
  tx: Transaction,
  invoiceId: string,
): Promise<InvoiceRow> {
  const [row] = await tx
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId))
    .for('update');
  if (!row) throw new ApiError('not_found', 'invoice not found');
  return row;
}

function assertInstallmentPlan(plan: Installment[] | null | undefined, totalKobo: bigint): void {
  if (!plan || plan.length === 0) return;
  let sum = 0n;
  for (const i of plan) {
    const amount = BigInt(i.amountKobo);
    if (amount <= 0n)
      throw new ApiError('validation_failed', 'installment amounts must be positive');
    sum += amount;
  }
  if (sum !== totalKobo) {
    throw new ApiError(
      'validation_failed',
      `installments (${sum}) must add up to the invoice total (${totalKobo})`,
      {
        details: { installmentsKobo: sum.toString(), totalKobo: totalKobo.toString() },
      },
    );
  }
}

/**
 * Inserts a draft invoice with server-computed lines and totals. Drafts carry
 * a provisional number; the INV-YYYY-NNNN number is assigned when issued.
 * Runs under a privileged context (the invoice policy is self-referencing).
 */
export async function createInvoiceRecord(
  tx: Transaction,
  fa: FinanceActor,
  input: InvoiceRecordInput,
): Promise<InvoiceRow> {
  const treatment = await loadTaxTreatment(tx, input.taxTreatmentKey ?? null);
  const totals = computeTotals(input.lines, treatment);
  if (totals.totalKobo <= 0n)
    throw new ApiError('validation_failed', 'invoice total must be positive');
  assertInstallmentPlan(input.installmentPlan ?? null, totals.totalKobo);
  const [invoice] = await tx
    .insert(schema.invoices)
    .values({
      organizationId: input.organizationId,
      number: `DRAFT-${randomUUID().slice(0, 8).toUpperCase()}`,
      kind: input.kind,
      status: 'draft',
      serviceRequestId: input.serviceRequestId ?? null,
      projectId: input.projectId ?? null,
      milestoneId: input.milestoneId ?? null,
      quoteVersionId: input.quoteVersionId ?? null,
      customerUserId: input.customerUserId,
      currency: input.currency,
      subtotalKobo: totals.subtotalKobo,
      taxKobo: totals.taxKobo,
      withholdingKobo: totals.withholdingKobo,
      totalKobo: totals.totalKobo,
      taxTreatmentKey: treatment?.key ?? null,
      taxTreatmentSnapshot: treatment,
      dueDate: input.dueDate ?? null,
      notes: input.notes ?? null,
      installmentPlan: input.installmentPlan ?? null,
      createdBy: input.createdBy ?? fa.actor.userId,
    })
    .returning();
  await tx.insert(schema.invoiceLines).values(
    totals.lines.map((l, index) => ({
      invoiceId: invoice!.id,
      description: l.description,
      quantity: l.quantity,
      unitAmountKobo: l.unitAmountKobo,
      amountKobo: l.amountKobo,
      taxRateBps: l.taxRateBps,
      taxKobo: l.taxKobo,
      accountCode: l.accountCode,
      sortOrder: index,
    })),
  );
  await recordAudit(tx, fa, {
    action: 'invoice.created',
    entityType: 'invoice',
    entityId: invoice!.id,
    organizationId: input.organizationId,
    after: {
      kind: input.kind,
      subtotalKobo: totals.subtotalKobo,
      taxKobo: totals.taxKobo,
      totalKobo: totals.totalKobo,
      serviceRequestId: input.serviceRequestId ?? null,
      quoteVersionId: input.quoteVersionId ?? null,
    },
  });
  return invoice!;
}

/**
 * draft → issued: assigns the INV number from the per-year sequence and posts
 * the `invoiceIssued` journal in the same transaction (privileged context).
 */
export async function issueInvoiceTx(
  tx: Transaction,
  fa: FinanceActor,
  invoice: InvoiceRow,
  options: { now: Date; dueDate: string | null },
): Promise<InvoiceRow> {
  const decision = evaluateTransition(invoiceMachine, {
    from: invoice.status,
    to: 'issued',
    actor: 'system',
  });
  if (!decision.ok) throw new ApiError('invalid_transition', decision.message);
  const number = await nextDocumentNumber(tx, 'invoices', options.now);
  const dueDate =
    options.dueDate ??
    invoice.dueDate ??
    new Date(options.now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  const [issued] = await tx
    .update(schema.invoices)
    .set({
      number,
      status: 'issued',
      issuedAt: options.now,
      issuedBy: fa.actor.userId,
      dueDate,
      version: invoice.version + 1,
    })
    .where(and(eq(schema.invoices.id, invoice.id), eq(schema.invoices.version, invoice.version)))
    .returning();
  if (!issued) throw new ApiError('version_conflict', 'invoice changed while issuing');
  const journal = await postJournal(
    tx,
    invoiceIssued({
      invoice: {
        id: issued.id,
        number: issued.number,
        organizationId: issued.organizationId,
        currency: issued.currency,
        kind: issued.kind,
        subtotalKobo: issued.subtotalKobo,
        taxKobo: issued.taxKobo,
        totalKobo: issued.totalKobo,
        isRentOnBehalfOfOwner: issued.isRentOnBehalfOfOwner,
        ownerOrganizationId: issued.ownerOrganizationId,
        estateSegment: issued.estateSegment,
      },
      // Default policy pending accountant review (docs/providers/accounting.md §5.1); deposits are always unearned.
      recognitionPolicy: 'on_issue',
    }),
    { postedBy: fa.actor.userId },
  );
  await emitEvent(tx, fa, {
    eventType: 'invoice.issued',
    aggregateType: 'invoice',
    aggregateId: issued.id,
    organizationId: issued.organizationId,
    payload: {
      invoiceId: issued.id,
      number: issued.number,
      customerUserId: issued.customerUserId,
      totalKobo: issued.totalKobo,
      currency: issued.currency,
      dueDate,
      serviceRequestId: issued.serviceRequestId,
    },
  });
  await recordAudit(tx, fa, {
    action: 'invoice.issued',
    entityType: 'invoice',
    entityId: issued.id,
    organizationId: issued.organizationId,
    before: { status: invoice.status, number: invoice.number },
    after: { status: 'issued', number, dueDate, journalId: journal.id },
  });
  return issued;
}

/** Finance creates an invoice manually (milestone, management fee, other) and optionally issues it. */
export async function createInvoice(
  rt: FinanceRuntime,
  fa: FinanceActor,
  input: InvoiceCreate,
): Promise<InvoiceDto> {
  assertStaff(fa, 'finance.invoices.manage', {
    type: 'invoice',
    organizationId: input.organizationId,
  });
  return withActor(rt.db, fa.ctx, async (tx) => {
    const [org] = await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, input.organizationId));
    if (!org) throw new ApiError('not_found', 'organisation not found');
    const record: InvoiceRecordInput = {
      organizationId: input.organizationId,
      customerUserId: input.customerUserId ?? null,
      kind: input.kind,
      serviceRequestId: input.serviceRequestId ?? null,
      projectId: input.projectId ?? null,
      milestoneId: input.milestoneId ?? null,
      quoteVersionId: input.quoteVersionId ?? null,
      lines: input.lines,
      currency: input.currency,
      taxTreatmentKey: input.taxTreatmentKey ?? null,
      dueDate: input.dueDate ?? null,
      notes: input.notes ?? null,
      installmentPlan: input.installmentPlan ?? null,
    };
    const invoice = await elevated(tx, fa, async () => {
      const draft = await createInvoiceRecord(tx, fa, record);
      return input.issue
        ? issueInvoiceTx(tx, fa, draft, { now: rt.now(), dueDate: input.dueDate ?? null })
        : draft;
    });
    return toInvoiceDto(invoice, await loadInvoiceLines(tx, invoice.id));
  });
}

export async function issueInvoice(
  rt: FinanceRuntime,
  fa: FinanceActor,
  invoiceId: string,
  input: { dueDate?: string; expectedVersion?: number },
): Promise<InvoiceDto> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const invoice = await loadInvoiceForUpdate(tx, invoiceId);
    assertStaff(fa, 'finance.invoices.manage', {
      type: 'invoice',
      id: invoice.id,
      organizationId: invoice.organizationId,
    });
    if (input.expectedVersion !== undefined && invoice.version !== input.expectedVersion) {
      throw new ApiError('version_conflict', 'invoice changed since you loaded it', {
        details: { currentVersion: invoice.version },
      });
    }
    const issued = await elevated(tx, fa, () =>
      issueInvoiceTx(tx, fa, invoice, { now: rt.now(), dueDate: input.dueDate ?? null }),
    );
    return toInvoiceDto(issued, await loadInvoiceLines(tx, issued.id));
  });
}

/** Reversing journal for an issued invoice, keyed `invoice:<id>:void`. */
export async function voidInvoiceTx(
  tx: Transaction,
  fa: FinanceActor,
  invoice: InvoiceRow,
  reason: string,
  now: Date,
): Promise<InvoiceRow> {
  const decision = evaluateTransition(invoiceMachine, {
    from: invoice.status,
    to: 'void',
    actor: 'staff',
    reason,
  });
  if (!decision.ok) throw new ApiError('invalid_transition', decision.message);
  if (invoice.amountPaidKobo > 0n || invoice.amountCreditedKobo > 0n) {
    throw new ApiError(
      'invalid_transition',
      'an invoice with allocations cannot be voided; issue a credit note instead',
    );
  }
  const [voided] = await tx
    .update(schema.invoices)
    .set({
      status: 'void',
      voidedAt: now,
      voidReason: reason,
      voidedBy: fa.actor.userId,
      version: invoice.version + 1,
    })
    .where(and(eq(schema.invoices.id, invoice.id), eq(schema.invoices.version, invoice.version)))
    .returning();
  if (!voided) throw new ApiError('version_conflict', 'invoice changed while voiding');
  let journalId: string | null = null;
  if (invoice.status !== 'draft') {
    const original = await findJournalByRef(tx, `invoice:${invoice.id}:issued`);
    if (original) {
      const draft = reverse(
        invoiceIssued({
          invoice: {
            id: invoice.id,
            number: invoice.number,
            organizationId: invoice.organizationId,
            currency: invoice.currency,
            kind: invoice.kind,
            subtotalKobo: invoice.subtotalKobo,
            taxKobo: invoice.taxKobo,
            totalKobo: invoice.totalKobo,
            isRentOnBehalfOfOwner: invoice.isRentOnBehalfOfOwner,
            ownerOrganizationId: invoice.ownerOrganizationId,
            estateSegment: invoice.estateSegment,
          },
          recognitionPolicy: 'on_issue',
        }),
        `invoice:${invoice.id}:void`,
        reason,
      );
      journalId = (await postJournal(tx, draft, { postedBy: fa.actor.userId })).id;
    }
  }
  await emitEvent(tx, fa, {
    eventType: 'invoice.voided',
    aggregateType: 'invoice',
    aggregateId: invoice.id,
    organizationId: invoice.organizationId,
    payload: { invoiceId: invoice.id, number: invoice.number, reason },
  });
  await recordAudit(tx, fa, {
    action: 'invoice.voided',
    entityType: 'invoice',
    entityId: invoice.id,
    organizationId: invoice.organizationId,
    before: { status: invoice.status },
    after: { status: 'void', journalId },
    reason,
  });
  return voided;
}

export async function voidInvoice(
  rt: FinanceRuntime,
  fa: FinanceActor,
  invoiceId: string,
  reason: string,
): Promise<InvoiceDto> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const invoice = await loadInvoiceForUpdate(tx, invoiceId);
    assertStaff(fa, 'finance.invoices.manage', {
      type: 'invoice',
      id: invoice.id,
      organizationId: invoice.organizationId,
    });
    const voided = await elevated(tx, fa, () => voidInvoiceTx(tx, fa, invoice, reason, rt.now()));
    return toInvoiceDto(voided, await loadInvoiceLines(tx, voided.id));
  });
}

/** Cancellation consequence: void every unpaid invoice of the engagement; paid ones are left for finance. */
export async function voidUnpaidInvoicesForRequest(
  tx: Transaction,
  fa: FinanceActor,
  serviceRequestId: string,
  reason: string,
  now: Date,
): Promise<string[]> {
  const system = systemFinanceActor(fa.correlationId);
  return elevated(tx, fa, async () => {
    const rows = await tx
      .select()
      .from(schema.invoices)
      .where(
        and(
          eq(schema.invoices.serviceRequestId, serviceRequestId),
          sql`${schema.invoices.status} in ('draft','issued','overdue')`,
          eq(schema.invoices.amountPaidKobo, 0n),
          eq(schema.invoices.amountCreditedKobo, 0n),
        ),
      )
      .for('update');
    const voided: string[] = [];
    for (const invoice of rows) {
      await voidInvoiceTx(
        tx,
        { ...system, actor: { ...system.actor, userId: fa.actor.userId } },
        invoice,
        reason,
        now,
      );
      voided.push(invoice.id);
    }
    return voided;
  });
}

/** Customer (`org.invoices.view`) or staff (`finance.read`) read. Row-level security applies first. */
export async function getInvoice(
  rt: FinanceRuntime,
  fa: FinanceActor,
  invoiceId: string,
): Promise<InvoiceDto> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const [invoice] = await tx
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, invoiceId));
    if (!invoice) throw new ApiError('not_found', 'invoice not found');
    assertStaffOrOrg(fa, 'finance.read', 'org.invoices.view', {
      type: 'invoice',
      id: invoice.id,
      organizationId: invoice.organizationId,
    });
    return toInvoiceDto(invoice, await loadInvoiceLines(tx, invoice.id));
  });
}

export async function listInvoices(
  rt: FinanceRuntime,
  fa: FinanceActor,
  query: InvoiceListQuery,
): Promise<Page<InvoiceDto>> {
  const staff = fa.actor.staffRoles.length > 0;
  const orgId = staff ? (query.organizationId ?? null) : fa.ctx.organizationId;
  if (staff) assertStaff(fa, 'finance.read');
  else {
    if (!orgId) return { items: [], nextCursor: null };
    assertStaffOrOrg(fa, 'finance.read', 'org.invoices.view', {
      type: 'invoice',
      organizationId: orgId,
    });
  }
  const cursor = decodeCursor(query.cursor);
  return withActor(rt.db, fa.ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.invoices)
      .where(
        and(
          orgId ? eq(schema.invoices.organizationId, orgId) : undefined,
          query.status ? eq(schema.invoices.status, query.status) : undefined,
          query.serviceRequestId
            ? eq(schema.invoices.serviceRequestId, query.serviceRequestId)
            : undefined,
          cursor
            ? or(
                lt(schema.invoices.createdAt, cursor.createdAt),
                and(
                  eq(schema.invoices.createdAt, cursor.createdAt),
                  lt(schema.invoices.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.invoices.createdAt), desc(schema.invoices.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const items: InvoiceDto[] = [];
    for (const inv of page) items.push(toInvoiceDto(inv, await loadInvoiceLines(tx, inv.id)));
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return { items, nextCursor: last ? encodeCursor(last.createdAt, last.id) : null };
  });
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const [ts, id] = text.split('|');
  if (!ts || !id) throw new ApiError('validation_failed', 'invalid cursor');
  const createdAt = new Date(ts);
  if (Number.isNaN(createdAt.getTime())) throw new ApiError('validation_failed', 'invalid cursor');
  return { createdAt, id };
}
