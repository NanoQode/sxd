import { desc, eq } from 'drizzle-orm';
import { ApiError, type ReceiptDto } from '@simplexd/contracts';
import { schema, withActor } from '@simplexd/db';
import { assertStaffOrOrg, type FinanceActor } from './actor';
import type { FinanceRuntime } from './runtime';

type ReceiptJoin = {
  receipt: typeof schema.receipts.$inferSelect;
  invoiceNumber: string;
  currency: string;
  allocation: {
    paymentAttemptId: string | null;
    bankReceiptId: string | null;
    creditNoteId: string | null;
  };
};

function toReceiptDto(r: ReceiptJoin): ReceiptDto {
  return {
    id: r.receipt.id,
    number: r.receipt.number,
    invoiceId: r.receipt.invoiceId,
    invoiceNumber: r.invoiceNumber,
    organizationId: r.receipt.organizationId,
    allocationId: r.receipt.allocationId,
    amountKobo: r.receipt.amountKobo.toString(),
    currency: r.currency,
    source: r.allocation.paymentAttemptId
      ? 'gateway'
      : r.allocation.bankReceiptId
        ? 'bank_transfer'
        : 'credit_note',
    issuedAt: r.receipt.issuedAt.toISOString(),
  };
}

const select = {
  receipt: schema.receipts,
  invoiceNumber: schema.invoices.number,
  currency: schema.invoices.currency,
  allocation: {
    paymentAttemptId: schema.allocations.paymentAttemptId,
    bankReceiptId: schema.allocations.bankReceiptId,
    creditNoteId: schema.allocations.creditNoteId,
  },
};

export async function getReceipt(
  rt: FinanceRuntime,
  fa: FinanceActor,
  id: string,
): Promise<ReceiptDto> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const [row] = await tx
      .select(select)
      .from(schema.receipts)
      .innerJoin(schema.invoices, eq(schema.invoices.id, schema.receipts.invoiceId))
      .innerJoin(schema.allocations, eq(schema.allocations.id, schema.receipts.allocationId))
      .where(eq(schema.receipts.id, id));
    if (!row) throw new ApiError('not_found', 'receipt not found');
    assertStaffOrOrg(fa, 'finance.read', 'org.invoices.view', {
      type: 'invoice',
      id: row.receipt.invoiceId,
      organizationId: row.receipt.organizationId,
    });
    return toReceiptDto(row);
  });
}

export async function listReceiptsForInvoice(
  rt: FinanceRuntime,
  fa: FinanceActor,
  invoiceId: string,
): Promise<ReceiptDto[]> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const [invoice] = await tx
      .select({ id: schema.invoices.id, organizationId: schema.invoices.organizationId })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, invoiceId));
    if (!invoice) throw new ApiError('not_found', 'invoice not found');
    assertStaffOrOrg(fa, 'finance.read', 'org.invoices.view', {
      type: 'invoice',
      id: invoice.id,
      organizationId: invoice.organizationId,
    });
    const rows = await tx
      .select(select)
      .from(schema.receipts)
      .innerJoin(schema.invoices, eq(schema.invoices.id, schema.receipts.invoiceId))
      .innerJoin(schema.allocations, eq(schema.allocations.id, schema.receipts.allocationId))
      .where(eq(schema.receipts.invoiceId, invoiceId))
      .orderBy(desc(schema.receipts.issuedAt));
    return rows.map(toReceiptDto);
  });
}
