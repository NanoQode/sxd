import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type {
  BankTransferReceiptDto,
  InvoiceDto,
  PaymentAttemptDto,
  QuoteDto,
  ReceiptDto,
} from '@simplexd/contracts';
import { ApiError } from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import {
  getInvoice,
  getQuote,
  listInvoices,
  listQuotesForRequest,
  listReceiptsForInvoice,
  toBankReceiptDto,
  toPaymentAttemptDto,
  type FinanceActor,
} from '@simplexd/finance';
import type { RequestIdentity } from '@/lib/auth/session';
import { getFinanceRuntime } from '@/server/finance/runtime';

/**
 * Finance read models for portal pages (server components). Permissions are
 * enforced inside @simplexd/finance; this module only adapts the request
 * identity into a FinanceActor and adds the per-invoice payment history,
 * which row-level security scopes to the caller's organisation.
 */

export function financeActorForPage(identity: RequestIdentity): FinanceActor {
  const correlationId = `page-${randomUUID()}`;
  return {
    actor: identity.actor,
    ctx: { ...identity.ctx, correlationId },
    correlationId,
    ipHash: null,
    userAgent: null,
  };
}

function notFoundToNull<T>(promise: Promise<T>): Promise<T | null> {
  return promise.catch((err: unknown) => {
    if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden')) return null;
    throw err;
  });
}

export async function loadQuotesForRequest(identity: RequestIdentity, requestId: string): Promise<QuoteDto[]> {
  return listQuotesForRequest(getFinanceRuntime(), financeActorForPage(identity), requestId);
}

export async function loadQuote(identity: RequestIdentity, id: string): Promise<QuoteDto | null> {
  return notFoundToNull(getQuote(getFinanceRuntime(), financeActorForPage(identity), id));
}

export async function loadInvoicesForRequest(identity: RequestIdentity, requestId: string): Promise<InvoiceDto[]> {
  if (!identity.ctx.organizationId) return [];
  const page = await listInvoices(getFinanceRuntime(), financeActorForPage(identity), {
    serviceRequestId: requestId,
    limit: 100,
  });
  return page.items.filter((i) => i.status !== 'draft');
}

export interface InvoiceDetail {
  invoice: InvoiceDto;
  receipts: ReceiptDto[];
  attempts: PaymentAttemptDto[];
  bankReceipts: BankTransferReceiptDto[];
}

export async function loadInvoiceDetail(identity: RequestIdentity, id: string): Promise<InvoiceDetail | null> {
  const rt = getFinanceRuntime();
  const fa = financeActorForPage(identity);
  const invoice = await notFoundToNull(getInvoice(rt, fa, id));
  if (!invoice) return null;
  const [receipts, history] = await Promise.all([
    listReceiptsForInvoice(rt, fa, id),
    withActor(getDb(), identity.ctx, async (tx) => {
      const attempts = await tx
        .select()
        .from(schema.paymentAttempts)
        .where(eq(schema.paymentAttempts.invoiceId, id))
        .orderBy(desc(schema.paymentAttempts.createdAt))
        .limit(50);
      const bankReceipts = await tx
        .select()
        .from(schema.bankTransferReceipts)
        .where(eq(schema.bankTransferReceipts.invoiceId, id))
        .orderBy(desc(schema.bankTransferReceipts.createdAt))
        .limit(50);
      return { attempts, bankReceipts };
    }),
  ]);
  return {
    invoice,
    receipts,
    attempts: history.attempts.map((a) => ({ ...toPaymentAttemptDto(a), accessCode: null })),
    bankReceipts: history.bankReceipts.map(toBankReceiptDto),
  };
}

/** Resolves the attempt a hosted checkout returned with, scoped by row-level security. */
export async function findAttemptByReference(
  identity: RequestIdentity,
  reference: string,
): Promise<PaymentAttemptDto | null> {
  if (!identity.session) return null;
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select()
      .from(schema.paymentAttempts)
      .where(
        and(
          eq(schema.paymentAttempts.reference, reference),
          identity.ctx.organizationId
            ? eq(schema.paymentAttempts.organizationId, identity.ctx.organizationId)
            : undefined,
        ),
      )
      .limit(1),
  );
  const row = rows[0];
  return row ? { ...toPaymentAttemptDto(row), accessCode: null } : null;
}
