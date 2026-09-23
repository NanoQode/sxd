import { and, eq } from 'drizzle-orm';
import { ApiError, type CreditNoteDto } from '@simplexd/contracts';
import { schema, withActor } from '@simplexd/db';
import {
  creditNoteIssued,
  planCreditNoteApplication,
  type OriginalRecognition,
} from '@simplexd/domain/ledger';
import { assertStaff, assertStaffOrOrg, elevated, requireUserId, type FinanceActor } from './actor';
import { emitEvent, recordAudit } from './audit';
import { isUniqueViolation, postJournal } from './journal';
import { iso } from './money';
import { nextDocumentNumber } from './numbering';
import type { FinanceRuntime } from './runtime';

export type CreditNoteRow = typeof schema.creditNotes.$inferSelect;

export function creditNoteDedupeKey(id: string): string {
  return `credit_note:${id}`;
}

export function toCreditNoteDto(c: CreditNoteRow): CreditNoteDto {
  return {
    id: c.id,
    number: c.number,
    invoiceId: c.invoiceId,
    organizationId: c.organizationId,
    amountKobo: c.amountKobo.toString(),
    currency: c.currency,
    reason: c.reason,
    status: c.status,
    issuedAt: iso(c.issuedAt),
    createdAt: c.createdAt.toISOString(),
  };
}

/**
 * Finance issues a credit note (`finance.invoices.manage`, MFA): the
 * `creditNoteIssued` journal and an allocation keyed `credit_note:<id>` reduce
 * the invoice balance through `planCreditNoteApplication`. Never a refund.
 */
export async function issueCreditNote(
  rt: FinanceRuntime,
  fa: FinanceActor,
  invoiceId: string,
  input: { amountKobo: string; reason: string },
): Promise<CreditNoteDto> {
  const userId = requireUserId(fa);
  return withActor(rt.db, fa.ctx, async (tx) => {
    const [visible] = await tx
      .select({ id: schema.invoices.id, organizationId: schema.invoices.organizationId })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, invoiceId));
    if (!visible) throw new ApiError('not_found', 'invoice not found');
    assertStaff(fa, 'finance.invoices.manage', {
      type: 'invoice',
      id: visible.id,
      organizationId: visible.organizationId,
    });
    const amount = BigInt(input.amountKobo);
    if (amount <= 0n) throw new ApiError('validation_failed', 'credit amount must be positive');
    const now = rt.now();
    return elevated(tx, fa, async () => {
      const [invoice] = await tx
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.id, invoiceId))
        .for('update');
      if (!invoice) throw new ApiError('not_found', 'invoice not found');
      const plan = planCreditNoteApplication({ invoice, amountKobo: amount });
      const number = await nextDocumentNumber(tx, 'credit_notes', now);
      const [note] = await tx
        .insert(schema.creditNotes)
        .values({
          organizationId: invoice.organizationId,
          invoiceId: invoice.id,
          number,
          amountKobo: amount,
          currency: invoice.currency,
          reason: input.reason,
          status: 'issued',
          issuedBy: userId,
          issuedAt: now,
        })
        .returning();
      const source: OriginalRecognition = invoice.isRentOnBehalfOfOwner
        ? 'rent_payable'
        : invoice.kind === 'deposit'
          ? 'unearned'
          : 'revenue';
      const journal = await postJournal(
        tx,
        creditNoteIssued({
          creditNote: {
            id: note!.id,
            number,
            invoiceId: invoice.id,
            organizationId: invoice.organizationId,
            currency: invoice.currency,
            amountKobo: amount,
          },
          source,
          estateSegment: invoice.estateSegment,
        }),
        { postedBy: userId },
      );
      try {
        await tx.insert(schema.allocations).values({
          organizationId: invoice.organizationId,
          invoiceId: invoice.id,
          creditNoteId: note!.id,
          amountKobo: amount,
          currency: invoice.currency,
          dedupeKey: creditNoteDedupeKey(note!.id),
          journalId: journal.id,
          allocatedBy: userId,
        });
      } catch (err) {
        if (isUniqueViolation(err))
          throw new ApiError('conflict', 'this credit note was already applied');
        throw err;
      }
      const [updatedInvoice] = await tx
        .update(schema.invoices)
        .set({
          amountCreditedKobo: plan.newAmountCreditedKobo,
          status: plan.newStatus,
          paidAt: plan.newStatus === 'paid' ? now : invoice.paidAt,
          version: invoice.version + 1,
        })
        .where(
          and(eq(schema.invoices.id, invoice.id), eq(schema.invoices.version, invoice.version)),
        )
        .returning();
      if (!updatedInvoice)
        throw new ApiError('version_conflict', 'invoice changed while crediting');
      const [applied] = await tx
        .update(schema.creditNotes)
        .set({ status: 'applied', journalId: journal.id })
        .where(eq(schema.creditNotes.id, note!.id))
        .returning();
      await emitEvent(tx, fa, {
        eventType: 'credit_note.issued',
        aggregateType: 'credit_note',
        aggregateId: note!.id,
        organizationId: invoice.organizationId,
        payload: {
          creditNoteId: note!.id,
          number,
          invoiceId: invoice.id,
          amountKobo: amount,
          invoiceStatus: plan.newStatus,
        },
      });
      await recordAudit(tx, fa, {
        action: 'credit_note.issued',
        entityType: 'credit_note',
        entityId: note!.id,
        organizationId: invoice.organizationId,
        after: { number, amountKobo: amount, journalId: journal.id, invoiceStatus: plan.newStatus },
        reason: input.reason,
      });
      return toCreditNoteDto(applied!);
    });
  });
}

export async function getCreditNote(
  rt: FinanceRuntime,
  fa: FinanceActor,
  id: string,
): Promise<CreditNoteDto> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const [row] = await tx.select().from(schema.creditNotes).where(eq(schema.creditNotes.id, id));
    if (!row) throw new ApiError('not_found', 'credit note not found');
    assertStaffOrOrg(fa, 'finance.read', 'org.invoices.view', {
      type: 'invoice',
      id: row.invoiceId,
      organizationId: row.organizationId,
    });
    return toCreditNoteDto(row);
  });
}
