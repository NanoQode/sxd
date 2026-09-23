import type { Kobo } from '../money';
import { evaluateTransition, invoiceMachine, type InvoiceState } from '../workflow';

/**
 * Pure allocation planning. Money verified on the server (a settled gateway
 * attempt or a finance-confirmed bank transfer) is applied to an invoice up to
 * its balance; anything beyond the balance is an overpayment held as a
 * customer deposit (account 2000), never silently swallowed. The application
 * inserts the allocation row with a dedupe key (`payment_attempt:<id>`) so a
 * replayed settlement cannot allocate twice.
 */

export interface InvoiceForAllocation {
  totalKobo: Kobo;
  amountPaidKobo: Kobo;
  amountCreditedKobo: Kobo;
  status: InvoiceState;
}

export interface AllocationPlan {
  /** Amount applied to the invoice (≤ balance). */
  allocatedKobo: Kobo;
  /** Amount beyond the balance, held as a customer deposit. */
  overpaymentKobo: Kobo;
  newStatus: 'partially_paid' | 'paid';
  /** A receipt is issued for every positive allocation. */
  receiptRequired: boolean;
  newAmountPaidKobo: Kobo;
  remainingBalanceKobo: Kobo;
}

export class AllocationError extends Error {
  override readonly name = 'AllocationError';
  readonly code: 'invalid_amount' | 'invoice_not_open' | 'invalid_transition';

  constructor(code: AllocationError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export function invoiceBalance(invoice: InvoiceForAllocation): Kobo {
  const balance = invoice.totalKobo - invoice.amountPaidKobo - invoice.amountCreditedKobo;
  return balance > 0n ? balance : 0n;
}

const ALLOCATABLE: ReadonlySet<InvoiceState> = new Set([
  'issued',
  'overdue',
  'partially_paid',
  'paid',
]);

export function planAllocation(input: {
  invoice: InvoiceForAllocation;
  amountKobo: Kobo;
}): AllocationPlan {
  const { invoice, amountKobo } = input;
  if (typeof amountKobo !== 'bigint' || amountKobo <= 0n) {
    throw new AllocationError(
      'invalid_amount',
      `allocation amount must be positive kobo, received ${String(amountKobo)}`,
    );
  }
  if (!ALLOCATABLE.has(invoice.status)) {
    throw new AllocationError(
      'invoice_not_open',
      `invoice in status ${invoice.status} cannot receive an allocation; issue it first or record the funds as a customer deposit`,
    );
  }
  const balance = invoiceBalance(invoice);
  const allocatedKobo = amountKobo < balance ? amountKobo : balance;
  const overpaymentKobo = amountKobo - allocatedKobo;
  const newAmountPaidKobo = invoice.amountPaidKobo + allocatedKobo;
  const remainingBalanceKobo = balance - allocatedKobo;
  const newStatus: 'partially_paid' | 'paid' =
    remainingBalanceKobo === 0n ? 'paid' : 'partially_paid';

  if (invoice.status !== newStatus) {
    const transition = evaluateTransition(invoiceMachine, {
      from: invoice.status,
      to: newStatus,
      actor: 'system',
    });
    if (!transition.ok) throw new AllocationError('invalid_transition', transition.message);
  }
  return {
    allocatedKobo,
    overpaymentKobo,
    newStatus,
    receiptRequired: allocatedKobo > 0n,
    newAmountPaidKobo,
    remainingBalanceKobo,
  };
}

export interface CreditPlan {
  creditedKobo: Kobo;
  newAmountCreditedKobo: Kobo;
  newStatus: InvoiceState;
  remainingBalanceKobo: Kobo;
}

/**
 * Credit notes reduce the balance (never below zero) and may complete the
 * invoice; they never create a refund by themselves.
 */
export function planCreditNoteApplication(input: {
  invoice: InvoiceForAllocation;
  amountKobo: Kobo;
}): CreditPlan {
  const { invoice, amountKobo } = input;
  if (typeof amountKobo !== 'bigint' || amountKobo <= 0n) {
    throw new AllocationError(
      'invalid_amount',
      `credit amount must be positive kobo, received ${String(amountKobo)}`,
    );
  }
  if (!ALLOCATABLE.has(invoice.status) || invoice.status === 'paid') {
    throw new AllocationError(
      'invoice_not_open',
      `invoice in status ${invoice.status} cannot be credited`,
    );
  }
  const balance = invoiceBalance(invoice);
  if (amountKobo > balance) {
    throw new AllocationError(
      'invalid_amount',
      `credit ${amountKobo} exceeds the invoice balance ${balance}`,
    );
  }
  const remainingBalanceKobo = balance - amountKobo;
  const newStatus: InvoiceState =
    remainingBalanceKobo === 0n
      ? 'paid'
      : invoice.amountPaidKobo > 0n
        ? 'partially_paid'
        : invoice.status;
  if (invoice.status !== newStatus) {
    const transition = evaluateTransition(invoiceMachine, {
      from: invoice.status,
      to: newStatus,
      actor: 'system',
    });
    if (!transition.ok) throw new AllocationError('invalid_transition', transition.message);
  }
  return {
    creditedKobo: amountKobo,
    newAmountCreditedKobo: invoice.amountCreditedKobo + amountKobo,
    newStatus,
    remainingBalanceKobo,
  };
}
