import { and, eq } from 'drizzle-orm';
import { ApiError, type BankTransferReceiptCreate, type BankTransferReceiptDto } from '@simplexd/contracts';
import { schema, withActor, type Transaction } from '@simplexd/db';
import { bankTransferConfirmed, planAllocation } from '@simplexd/domain/ledger';
import { assertOrg, assertStaff, assertStaffOrOrg, elevated, requireUserId, type FinanceActor } from './actor';
import { emitEvent, recordAudit } from './audit';
import { transitionEngagement } from './engagements/transitions';
import { isUniqueViolation, postJournal } from './journal';
import { iso } from './money';
import { nextDocumentNumber } from './numbering';
import type { FinanceRuntime } from './runtime';

export type BankReceiptRow = typeof schema.bankTransferReceipts.$inferSelect;

export function bankReceiptDedupeKey(receiptId: string): string {
  return `bank_receipt:${receiptId}`;
}

export function toBankReceiptDto(r: BankReceiptRow): BankTransferReceiptDto {
  return {
    id: r.id,
    invoiceId: r.invoiceId,
    organizationId: r.organizationId,
    declaredAmountKobo: r.declaredAmountKobo.toString(),
    declaredPaidAt: r.declaredPaidAt,
    bankReference: r.bankReference,
    uploadedFileId: r.uploadedFileId,
    status: r.status,
    reviewNote: r.reviewNote,
    reviewedAt: iso(r.reviewedAt),
    createdAt: r.createdAt.toISOString(),
  };
}

async function loadReceiptForUpdate(tx: Transaction, id: string): Promise<BankReceiptRow> {
  const [row] = await tx.select().from(schema.bankTransferReceipts).where(eq(schema.bankTransferReceipts.id, id)).for('update');
  if (!row) throw new ApiError('not_found', 'bank transfer receipt not found');
  return row;
}

/** Customer declares a transfer (`org.invoices.pay`). A declared receipt is not cleared money and posts nothing. */
export async function submitBankTransferReceipt(
  rt: FinanceRuntime,
  fa: FinanceActor,
  invoiceId: string,
  input: BankTransferReceiptCreate,
): Promise<BankTransferReceiptDto> {
  const userId = requireUserId(fa);
  return withActor(rt.db, fa.ctx, async (tx) => {
    const [invoice] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    if (!invoice) throw new ApiError('not_found', 'invoice not found');
    assertOrg(fa, 'org.invoices.pay', { type: 'invoice', id: invoice.id, organizationId: invoice.organizationId });
    if (!['issued', 'partially_paid', 'overdue'].includes(invoice.status)) {
      throw new ApiError('invalid_transition', `invoice ${invoice.number} is ${invoice.status} and cannot receive a transfer`);
    }
    const declared = BigInt(input.declaredAmountKobo);
    if (declared <= 0n) throw new ApiError('validation_failed', 'declared amount must be positive');
    if (input.uploadedFileId) {
      const [file] = await tx.select({ id: schema.fileObjects.id, status: schema.fileObjects.status }).from(schema.fileObjects).where(eq(schema.fileObjects.id, input.uploadedFileId));
      if (!file) throw new ApiError('not_found', 'uploaded file not found or not accessible');
    }
    const [row] = await tx
      .insert(schema.bankTransferReceipts)
      .values({
        organizationId: invoice.organizationId,
        invoiceId: invoice.id,
        uploadedFileId: input.uploadedFileId ?? null,
        declaredAmountKobo: declared,
        declaredPaidAt: input.declaredPaidAt ?? null,
        bankReference: input.bankReference ?? null,
        status: 'submitted',
        submittedBy: userId,
      })
      .returning();
    await emitEvent(tx, fa, {
      eventType: 'bank_transfer.declared',
      aggregateType: 'bank_transfer_receipt',
      aggregateId: row!.id,
      organizationId: invoice.organizationId,
      payload: { receiptId: row!.id, invoiceId: invoice.id, invoiceNumber: invoice.number, declaredAmountKobo: declared },
    });
    await recordAudit(tx, fa, {
      action: 'bank_transfer_receipt.submitted',
      entityType: 'bank_transfer_receipt',
      entityId: row!.id,
      organizationId: invoice.organizationId,
      after: { invoiceId: invoice.id, declaredAmountKobo: declared, bankReference: input.bankReference ?? null },
    });
    return toBankReceiptDto(row!);
  });
}

/**
 * Finance confirms the credit on the bank statement (`finance.allocations.manage`,
 * MFA): one allocation keyed `bank_receipt:<id>`, the `bankTransferConfirmed`
 * journal and a receipt — posted exactly once.
 */
export async function confirmBankTransferReceipt(
  rt: FinanceRuntime,
  fa: FinanceActor,
  receiptId: string,
  input: { confirmedAmountKobo: string; note?: string },
): Promise<{ receipt: BankTransferReceiptDto; receiptNumber: string | null; invoiceStatus: string }> {
  const userId = requireUserId(fa);
  return withActor(rt.db, fa.ctx, async (tx) => {
    const receipt = await loadReceiptForUpdate(tx, receiptId);
    assertStaff(fa, 'finance.allocations.manage', { type: 'invoice', id: receipt.invoiceId, organizationId: receipt.organizationId });
    if (receipt.status === 'confirmed') throw new ApiError('conflict', 'this transfer was already confirmed');
    if (receipt.status === 'rejected') throw new ApiError('invalid_transition', 'a rejected receipt cannot be confirmed; ask the customer to resubmit');
    const confirmed = BigInt(input.confirmedAmountKobo);
    if (confirmed <= 0n) throw new ApiError('validation_failed', 'confirmed amount must be positive');
    const now = rt.now();
    return elevated(tx, fa, async () => {
      const [invoice] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, receipt.invoiceId)).for('update');
      if (!invoice) throw new ApiError('not_found', 'invoice not found');
      const [existing] = await tx.select({ id: schema.allocations.id }).from(schema.allocations).where(eq(schema.allocations.dedupeKey, bankReceiptDedupeKey(receipt.id)));
      if (existing) throw new ApiError('conflict', 'this transfer was already allocated');
      const plan = planAllocation({ invoice, amountKobo: confirmed });
      const journal = await postJournal(
        tx,
        bankTransferConfirmed({
          receipt: { id: receipt.id, invoiceId: invoice.id, organizationId: invoice.organizationId, currency: invoice.currency, confirmedAmountKobo: confirmed, status: 'confirmed' },
          allocatedKobo: plan.allocatedKobo,
          overpaymentKobo: plan.overpaymentKobo,
          isRentOnBehalfOfOwner: invoice.isRentOnBehalfOfOwner,
          estateSegment: invoice.estateSegment,
        }),
        { postedBy: userId },
      );
      let allocationId: string;
      try {
        const [allocation] = await tx
          .insert(schema.allocations)
          .values({
            organizationId: invoice.organizationId,
            invoiceId: invoice.id,
            bankReceiptId: receipt.id,
            amountKobo: confirmed,
            currency: invoice.currency,
            dedupeKey: bankReceiptDedupeKey(receipt.id),
            journalId: journal.id,
            allocatedBy: userId,
          })
          .returning({ id: schema.allocations.id });
        allocationId = allocation!.id;
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError('conflict', 'this transfer was already allocated');
        throw err;
      }
      const [updatedInvoice] = await tx
        .update(schema.invoices)
        .set({ amountPaidKobo: plan.newAmountPaidKobo, status: plan.newStatus, paidAt: plan.newStatus === 'paid' ? now : invoice.paidAt, version: invoice.version + 1 })
        .where(and(eq(schema.invoices.id, invoice.id), eq(schema.invoices.version, invoice.version)))
        .returning();
      if (!updatedInvoice) throw new ApiError('version_conflict', 'invoice changed during confirmation');
      let receiptNumber: string | null = null;
      if (plan.receiptRequired) {
        receiptNumber = await nextDocumentNumber(tx, 'receipts', now);
        await tx.insert(schema.receipts).values({ organizationId: invoice.organizationId, invoiceId: invoice.id, allocationId, number: receiptNumber, amountKobo: plan.allocatedKobo });
      }
      const [updated] = await tx
        .update(schema.bankTransferReceipts)
        .set({ status: 'confirmed', reviewedBy: userId, reviewedAt: now, reviewNote: input.note ?? null })
        .where(eq(schema.bankTransferReceipts.id, receipt.id))
        .returning();
      if (plan.newStatus === 'paid' && invoice.serviceRequestId) {
        const [sr] = await tx.select().from(schema.serviceRequests).where(eq(schema.serviceRequests.id, invoice.serviceRequestId)).for('update');
        if (sr && sr.status === 'awaiting_payment') {
          await transitionEngagement(tx, fa, { sr, to: 'in_progress', actorKind: 'staff', metadata: { invoiceId: invoice.id, bankReceiptId: receipt.id, receiptNumber, billingConsequence: 'bank_transfer_confirmed' } });
        }
      }
      await emitEvent(tx, fa, {
        eventType: 'payment.settled',
        aggregateType: 'bank_transfer_receipt',
        aggregateId: receipt.id,
        organizationId: invoice.organizationId,
        payload: { bankReceiptId: receipt.id, invoiceId: invoice.id, invoiceNumber: updatedInvoice.number, customerUserId: invoice.customerUserId, amountKobo: confirmed, allocatedKobo: plan.allocatedKobo, overpaymentKobo: plan.overpaymentKobo, receiptNumber, source: 'bank_transfer' },
      });
      await emitEvent(tx, fa, {
        eventType: plan.newStatus === 'paid' ? 'invoice.paid' : 'invoice.partially_paid',
        aggregateType: 'invoice',
        aggregateId: invoice.id,
        organizationId: invoice.organizationId,
        payload: { invoiceId: invoice.id, invoiceNumber: updatedInvoice.number, status: plan.newStatus, amountPaidKobo: plan.newAmountPaidKobo },
      });
      await recordAudit(tx, fa, {
        action: 'bank_transfer_receipt.confirmed',
        entityType: 'bank_transfer_receipt',
        entityId: receipt.id,
        organizationId: invoice.organizationId,
        before: { status: receipt.status, declaredAmountKobo: receipt.declaredAmountKobo },
        after: { status: 'confirmed', confirmedAmountKobo: confirmed, allocationId, journalId: journal.id, receiptNumber, invoiceStatus: plan.newStatus },
        reason: input.note ?? null,
      });
      return { receipt: toBankReceiptDto(updated!), receiptNumber, invoiceStatus: plan.newStatus };
    });
  });
}

export async function rejectBankTransferReceipt(rt: FinanceRuntime, fa: FinanceActor, receiptId: string, input: { note: string }): Promise<BankTransferReceiptDto> {
  const userId = requireUserId(fa);
  return withActor(rt.db, fa.ctx, async (tx) => {
    const receipt = await loadReceiptForUpdate(tx, receiptId);
    assertStaff(fa, 'finance.allocations.manage', { type: 'invoice', id: receipt.invoiceId, organizationId: receipt.organizationId });
    if (receipt.status === 'confirmed') throw new ApiError('invalid_transition', 'a confirmed transfer cannot be rejected; issue a credit note or refund instead');
    const [updated] = await tx
      .update(schema.bankTransferReceipts)
      .set({ status: 'rejected', reviewedBy: userId, reviewedAt: rt.now(), reviewNote: input.note })
      .where(eq(schema.bankTransferReceipts.id, receipt.id))
      .returning();
    await emitEvent(tx, fa, {
      eventType: 'bank_transfer.rejected',
      aggregateType: 'bank_transfer_receipt',
      aggregateId: receipt.id,
      organizationId: receipt.organizationId,
      payload: { receiptId: receipt.id, invoiceId: receipt.invoiceId, note: input.note },
    });
    await recordAudit(tx, fa, {
      action: 'bank_transfer_receipt.rejected',
      entityType: 'bank_transfer_receipt',
      entityId: receipt.id,
      organizationId: receipt.organizationId,
      before: { status: receipt.status },
      after: { status: 'rejected' },
      reason: input.note,
    });
    return toBankReceiptDto(updated!);
  });
}

export async function getBankTransferReceipt(rt: FinanceRuntime, fa: FinanceActor, receiptId: string): Promise<BankTransferReceiptDto> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const [row] = await tx.select().from(schema.bankTransferReceipts).where(eq(schema.bankTransferReceipts.id, receiptId));
    if (!row) throw new ApiError('not_found', 'bank transfer receipt not found');
    assertStaffOrOrg(fa, 'finance.read', 'org.invoices.view', { type: 'invoice', id: row.invoiceId, organizationId: row.organizationId });
    return toBankReceiptDto(row);
  });
}
