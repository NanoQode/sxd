import { NGN, bpsOf, type Kobo } from '../money';
import { ACCOUNTS, type AccountCode, type RevenueAccount } from './accounts';
import {
  JournalError,
  assertBalanced,
  assertCurrency,
  assertNonNegativeKobo,
  assertPositiveKobo,
  credit,
  debit,
  reverse,
  type JournalDraft,
  type JournalLineDraft,
} from './journal';

/**
 * Pure posting builders. Each returns a balanced `JournalDraft` with a unique
 * business-event reference derived from its source record, so posting the same
 * event twice is rejected by the `journals.business_event_ref` unique index.
 * Treatment is documented with T-accounts in docs/providers/accounting.md;
 * the business accountant reviews that document, not this file.
 */

export type RecognitionPolicy = 'on_issue' | 'on_delivery';

export type InvoiceKind =
  | 'service'
  | 'deposit'
  | 'installment'
  | 'management_fee'
  | 'rent'
  | 'service_charge'
  | 'tender_fee'
  | 'procurement'
  | 'other';

/** Where the money originally went; decides which account a refund or credit note reduces. */
export type OriginalRecognition = 'revenue' | 'unearned' | 'rent_payable';

export type ProviderRefundStatusLike = 'pending' | 'processing' | 'processed' | 'failed' | 'needs_attention';

interface Party {
  organizationId?: string | null;
  estateSegment?: string | null;
}

function base(
  businessEventRef: string,
  description: string,
  sourceType: string,
  sourceId: string,
  currency: string | null | undefined,
  party: Party,
  lines: JournalLineDraft[],
): JournalDraft {
  if (!sourceId || sourceId.trim().length === 0) {
    throw new JournalError(`${sourceType} posting needs a source id`, { sourceType });
  }
  const draft: JournalDraft = {
    businessEventRef,
    description,
    sourceType,
    sourceId,
    currency: assertCurrency(currency ?? NGN),
    lines,
  };
  if (party.organizationId) draft.organizationId = party.organizationId;
  if (party.estateSegment) draft.estateSegment = party.estateSegment;
  assertBalanced(draft);
  return draft;
}

/** Maps an invoice kind to the revenue account it earns; rent for owners is not revenue. */
export function revenueAccountForInvoiceKind(kind: InvoiceKind, override?: RevenueAccount): RevenueAccount {
  if (override) return override;
  switch (kind) {
    case 'management_fee':
      return ACCOUNTS.MANAGEMENT_FEE_REVENUE;
    case 'tender_fee':
    case 'procurement':
      return ACCOUNTS.TENDER_AND_PROCUREMENT_FEE_REVENUE;
    default:
      return ACCOUNTS.SERVICE_REVENUE;
  }
}

function receivableAccount(isRentOnBehalfOfOwner: boolean | undefined): AccountCode {
  return isRentOnBehalfOfOwner
    ? ACCOUNTS.RENT_RECEIVABLE_ON_BEHALF_OF_OWNERS
    : ACCOUNTS.CUSTOMER_RECEIVABLES;
}

function recognitionAccount(source: OriginalRecognition, revenueAccount: RevenueAccount): AccountCode {
  switch (source) {
    case 'revenue':
      return revenueAccount;
    case 'unearned':
      return ACCOUNTS.CUSTOMER_DEPOSITS_AND_UNEARNED_REVENUE;
    case 'rent_payable':
      return ACCOUNTS.RENT_COLLECTED_PAYABLE_TO_OWNERS;
  }
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export interface InvoiceIssuedInput {
  invoice: {
    id: string;
    number?: string;
    organizationId: string;
    currency?: string;
    kind: InvoiceKind;
    /** Net of tax. */
    subtotalKobo: Kobo;
    /** VAT or other tax charged to the customer (collected on behalf of the tax authority). */
    taxKobo?: Kobo;
    /** Gross amount owed = subtotal + tax. */
    totalKobo: Kobo;
    isRentOnBehalfOfOwner?: boolean;
    ownerOrganizationId?: string | null;
    estateSegment?: string | null;
  };
  /** Ignored for rent (always a liability) and deposits (always unearned until delivery). */
  recognitionPolicy: RecognitionPolicy;
  /** Override for kinds without a dedicated invoice kind, e.g. referral revenue 4300. */
  revenueAccount?: RevenueAccount;
}

/**
 * Invoice issued.
 *   Service:  Dr 1200 total / Cr revenue (on_issue) or 2000 (on_delivery, deposits) subtotal / Cr 2300 tax
 *   Rent for an owner: Dr 1300 total / Cr 2100 subtotal / Cr 2300 tax — never revenue.
 */
export function invoiceIssued(input: InvoiceIssuedInput): JournalDraft {
  const { invoice } = input;
  const subtotal = assertPositiveKobo('subtotalKobo', invoice.subtotalKobo);
  const tax = assertNonNegativeKobo('taxKobo', invoice.taxKobo ?? 0n);
  const total = assertPositiveKobo('totalKobo', invoice.totalKobo);
  if (subtotal + tax !== total) {
    throw new JournalError(`invoice ${invoice.id}: totalKobo ${total} must equal subtotal ${subtotal} + tax ${tax}`, {
      invoiceId: invoice.id,
    });
  }
  const label = invoice.number ?? invoice.id;
  const entity = { entityType: 'invoice', entityId: invoice.id };
  const lines: JournalLineDraft[] = [];
  let description: string;

  if (invoice.isRentOnBehalfOfOwner) {
    if (invoice.kind !== 'rent' && invoice.kind !== 'service_charge') {
      throw new JournalError(`invoice ${invoice.id}: only rent or service-charge invoices can be collected on behalf of an owner`, {
        invoiceId: invoice.id,
        kind: invoice.kind,
      });
    }
    lines.push(debit(ACCOUNTS.RENT_RECEIVABLE_ON_BEHALF_OF_OWNERS, total, { ...entity, memo: `Rent invoice ${label}` }));
    lines.push(
      credit(ACCOUNTS.RENT_COLLECTED_PAYABLE_TO_OWNERS, subtotal, {
        entityType: 'organization',
        ...(invoice.ownerOrganizationId ? { entityId: invoice.ownerOrganizationId, organizationId: invoice.ownerOrganizationId } : {}),
        memo: `Rent payable to owner for ${label}`,
      }),
    );
    description = `Rent invoice ${label} issued (collected on behalf of owner)`;
  } else {
    const revenueAccount = revenueAccountForInvoiceKind(invoice.kind, input.revenueAccount);
    const recogniseNow = input.recognitionPolicy === 'on_issue' && invoice.kind !== 'deposit';
    lines.push(debit(ACCOUNTS.CUSTOMER_RECEIVABLES, total, { ...entity, memo: `Invoice ${label}` }));
    lines.push(
      recogniseNow
        ? credit(revenueAccount, subtotal, { ...entity, memo: `Revenue recognised on issue for ${label}` })
        : credit(ACCOUNTS.CUSTOMER_DEPOSITS_AND_UNEARNED_REVENUE, subtotal, {
            ...entity,
            memo: `Unearned until delivery for ${label}`,
          }),
    );
    description = `Invoice ${label} issued (${invoice.kind}, ${recogniseNow ? 'revenue on issue' : 'unearned until delivery'})`;
  }
  if (tax > 0n) {
    lines.push(credit(ACCOUNTS.TAX_AND_WITHHOLDING_PAYABLE, tax, { ...entity, memo: `Tax charged on ${label}` }));
  }
  return base(
    `invoice:${invoice.id}:issued`,
    description,
    'invoice',
    invoice.id,
    invoice.currency,
    { organizationId: invoice.organizationId, estateSegment: invoice.estateSegment },
    lines,
  );
}

export interface RevenueRecognizedInput {
  invoice: { id: string; number?: string; organizationId: string; currency?: string; kind: InvoiceKind; estateSegment?: string | null };
  amountKobo: Kobo;
  revenueAccount?: RevenueAccount;
  /** Distinguishes several recognitions of one invoice (milestones). */
  eventKey?: string;
}

/** Delivery of a deposit / on_delivery invoice: Dr 2000 / Cr revenue. */
export function revenueRecognized(input: RevenueRecognizedInput): JournalDraft {
  const amount = assertPositiveKobo('amountKobo', input.amountKobo);
  const revenueAccount = revenueAccountForInvoiceKind(input.invoice.kind, input.revenueAccount);
  const label = input.invoice.number ?? input.invoice.id;
  const entity = { entityType: 'invoice', entityId: input.invoice.id };
  const suffix = input.eventKey ? `:${input.eventKey}` : '';
  return base(
    `invoice:${input.invoice.id}:recognized${suffix}`,
    `Revenue recognised on delivery for invoice ${label}`,
    'invoice',
    input.invoice.id,
    input.invoice.currency,
    { organizationId: input.invoice.organizationId, estateSegment: input.invoice.estateSegment },
    [
      debit(ACCOUNTS.CUSTOMER_DEPOSITS_AND_UNEARNED_REVENUE, amount, { ...entity, memo: `Released from unearned for ${label}` }),
      credit(revenueAccount, amount, { ...entity, memo: `Earned on delivery for ${label}` }),
    ],
  );
}

// ---------------------------------------------------------------------------
// Money in
// ---------------------------------------------------------------------------

export interface GatewayPaymentSettledInput {
  attempt: {
    id: string;
    reference?: string;
    invoiceId: string;
    organizationId: string;
    currency?: string;
    amountKobo: Kobo;
    /** Provider fee when the verify response reports it; null/undefined when unknown. */
    feesKobo?: Kobo | null;
  };
  /** From `planAllocation`; allocated + overpayment must equal the attempt amount. */
  allocatedKobo: Kobo;
  overpaymentKobo?: Kobo;
  isRentOnBehalfOfOwner?: boolean;
  estateSegment?: string | null;
}

/**
 * Verified gateway payment: Dr 1100 clearing amount / Cr receivable allocated
 * (/ Cr 2000 overpayment). Known fees: Dr 5000 / Cr 1100.
 */
export function gatewayPaymentSettled(input: GatewayPaymentSettledInput): JournalDraft {
  const { attempt } = input;
  const amount = assertPositiveKobo('attempt.amountKobo', attempt.amountKobo);
  const allocated = assertNonNegativeKobo('allocatedKobo', input.allocatedKobo);
  const overpayment = assertNonNegativeKobo('overpaymentKobo', input.overpaymentKobo ?? 0n);
  if (allocated + overpayment !== amount) {
    throw new JournalError(
      `payment attempt ${attempt.id}: allocated ${allocated} + overpayment ${overpayment} must equal the attempt amount ${amount}`,
      { paymentAttemptId: attempt.id },
    );
  }
  const fees = attempt.feesKobo === undefined || attempt.feesKobo === null ? null : assertNonNegativeKobo('feesKobo', attempt.feesKobo);
  if (fees !== null && fees > amount) {
    throw new JournalError(`payment attempt ${attempt.id}: fees ${fees} exceed the amount ${amount}`, {
      paymentAttemptId: attempt.id,
    });
  }
  const label = attempt.reference ?? attempt.id;
  const lines: JournalLineDraft[] = [
    debit(ACCOUNTS.GATEWAY_CLEARING, amount, { entityType: 'payment_attempt', entityId: attempt.id, memo: `Gateway payment ${label}` }),
  ];
  if (allocated > 0n) {
    lines.push(
      credit(receivableAccount(input.isRentOnBehalfOfOwner), allocated, {
        entityType: 'invoice',
        entityId: attempt.invoiceId,
        memo: `Allocated to invoice from ${label}`,
      }),
    );
  }
  if (overpayment > 0n) {
    lines.push(
      credit(ACCOUNTS.CUSTOMER_DEPOSITS_AND_UNEARNED_REVENUE, overpayment, {
        entityType: 'invoice',
        entityId: attempt.invoiceId,
        memo: `Overpayment held as customer deposit from ${label}`,
      }),
    );
  }
  if (fees !== null && fees > 0n) {
    lines.push(debit(ACCOUNTS.GATEWAY_FEES, fees, { entityType: 'payment_attempt', entityId: attempt.id, memo: `Gateway fee for ${label}` }));
    lines.push(credit(ACCOUNTS.GATEWAY_CLEARING, fees, { entityType: 'payment_attempt', entityId: attempt.id, memo: `Fee deducted by gateway for ${label}` }));
  }
  return base(
    `payment_attempt:${attempt.id}:settled`,
    `Gateway payment ${label} verified and settled`,
    'payment_attempt',
    attempt.id,
    attempt.currency,
    { organizationId: attempt.organizationId, estateSegment: input.estateSegment },
    lines,
  );
}

export interface GatewaySettlementToBankInput {
  settlement: {
    /** Provider settlement/payout batch id or bank statement line id. */
    id: string;
    organizationId?: string | null;
    currency?: string;
    /** Amount that reached the bank. */
    amountKobo: Kobo;
    /** Fees deducted at settlement that were not already expensed per payment. */
    feesKobo?: Kobo | null;
  };
}

/** Gateway pays out to the bank: Dr 1000 / Cr 1100 (plus Dr 5000 / Cr 1100 for fees not yet expensed). */
export function gatewaySettlementToBank(input: GatewaySettlementToBankInput): JournalDraft {
  const { settlement } = input;
  const amount = assertPositiveKobo('settlement.amountKobo', settlement.amountKobo);
  const fees = settlement.feesKobo ? assertNonNegativeKobo('feesKobo', settlement.feesKobo) : 0n;
  const entity = { entityType: 'gateway_settlement', entityId: settlement.id };
  const lines: JournalLineDraft[] = [
    debit(ACCOUNTS.BANK, amount, { ...entity, memo: `Gateway settlement ${settlement.id} received` }),
    credit(ACCOUNTS.GATEWAY_CLEARING, amount, { ...entity, memo: `Cleared from gateway balance` }),
  ];
  if (fees > 0n) {
    lines.push(debit(ACCOUNTS.GATEWAY_FEES, fees, { ...entity, memo: 'Settlement fees' }));
    lines.push(credit(ACCOUNTS.GATEWAY_CLEARING, fees, { ...entity, memo: 'Settlement fees deducted' }));
  }
  return base(
    `gateway_settlement:${settlement.id}:received`,
    `Gateway settlement ${settlement.id} received in bank`,
    'gateway_settlement',
    settlement.id,
    settlement.currency,
    { organizationId: settlement.organizationId },
    lines,
  );
}

export type BankReceiptStatus = 'submitted' | 'under_review' | 'confirmed' | 'rejected';

export interface BankTransferConfirmedInput {
  receipt: {
    id: string;
    invoiceId: string;
    organizationId: string;
    currency?: string;
    /** Amount finance confirmed on the bank statement (not the declared amount). */
    confirmedAmountKobo: Kobo;
    status: BankReceiptStatus;
  };
  allocatedKobo: Kobo;
  overpaymentKobo?: Kobo;
  isRentOnBehalfOfOwner?: boolean;
  estateSegment?: string | null;
}

/**
 * Finance-confirmed bank transfer: Dr 1000 / Cr receivable (/ Cr 2000 overpayment).
 * Declared or under-review receipts never post: an uploaded receipt is not cleared money.
 */
export function bankTransferConfirmed(input: BankTransferConfirmedInput): JournalDraft {
  const { receipt } = input;
  if (receipt.status !== 'confirmed') {
    throw new JournalError(
      `bank transfer receipt ${receipt.id} is ${receipt.status}; only finance-confirmed receipts post (declared receipts are not cleared money)`,
      { receiptId: receipt.id, status: receipt.status },
    );
  }
  const amount = assertPositiveKobo('confirmedAmountKobo', receipt.confirmedAmountKobo);
  const allocated = assertNonNegativeKobo('allocatedKobo', input.allocatedKobo);
  const overpayment = assertNonNegativeKobo('overpaymentKobo', input.overpaymentKobo ?? 0n);
  if (allocated + overpayment !== amount) {
    throw new JournalError(
      `bank transfer receipt ${receipt.id}: allocated ${allocated} + overpayment ${overpayment} must equal the confirmed amount ${amount}`,
      { receiptId: receipt.id },
    );
  }
  const lines: JournalLineDraft[] = [
    debit(ACCOUNTS.BANK, amount, { entityType: 'bank_transfer_receipt', entityId: receipt.id, memo: `Bank transfer confirmed ${receipt.id}` }),
  ];
  if (allocated > 0n) {
    lines.push(
      credit(receivableAccount(input.isRentOnBehalfOfOwner), allocated, {
        entityType: 'invoice',
        entityId: receipt.invoiceId,
        memo: 'Allocated to invoice from confirmed bank transfer',
      }),
    );
  }
  if (overpayment > 0n) {
    lines.push(
      credit(ACCOUNTS.CUSTOMER_DEPOSITS_AND_UNEARNED_REVENUE, overpayment, {
        entityType: 'invoice',
        entityId: receipt.invoiceId,
        memo: 'Overpayment held as customer deposit',
      }),
    );
  }
  return base(
    `bank_transfer_receipt:${receipt.id}:confirmed`,
    `Bank transfer ${receipt.id} confirmed by finance`,
    'bank_transfer_receipt',
    receipt.id,
    receipt.currency,
    { organizationId: receipt.organizationId, estateSegment: input.estateSegment },
    lines,
  );
}

// ---------------------------------------------------------------------------
// Refunds, chargebacks, credit notes
// ---------------------------------------------------------------------------

export type RefundStatusLike = 'requested' | 'approved' | 'submitted' | 'pending' | 'settled' | 'failed' | 'rejected';

export interface RefundApprovedInput {
  refund: {
    id: string;
    invoiceId: string;
    organizationId: string;
    currency?: string;
    amountKobo: Kobo;
    status: RefundStatusLike;
  };
  /** How the refunded money was originally recognised. */
  source: OriginalRecognition;
  revenueAccount?: RevenueAccount;
  estateSegment?: string | null;
}

/** Refund approved (step-up auth + second approver in the app): Dr revenue|2000|2100 / Cr 2200. */
export function refundApproved(input: RefundApprovedInput): JournalDraft {
  const { refund } = input;
  if (refund.status !== 'approved') {
    throw new JournalError(`refund ${refund.id} is ${refund.status}; only approved refunds create a refund liability`, {
      refundId: refund.id,
      status: refund.status,
    });
  }
  const amount = assertPositiveKobo('refund.amountKobo', refund.amountKobo);
  const from = recognitionAccount(input.source, input.revenueAccount ?? ACCOUNTS.SERVICE_REVENUE);
  const entity = { entityType: 'refund', entityId: refund.id };
  return base(
    `refund:${refund.id}:approved`,
    `Refund ${refund.id} approved`,
    'refund',
    refund.id,
    refund.currency,
    { organizationId: refund.organizationId, estateSegment: input.estateSegment },
    [
      debit(from, amount, { ...entity, memo: `Refund reduces ${input.source}` }),
      credit(ACCOUNTS.REFUNDS_PAYABLE, amount, { ...entity, memo: 'Refund owed to customer' }),
    ],
  );
}

export interface RefundSettledInput {
  refund: {
    id: string;
    organizationId: string;
    currency?: string;
    amountKobo: Kobo;
    status: RefundStatusLike;
  };
  /** Must be `processed`: a submitted or pending provider refund is not settled. */
  providerStatus: ProviderRefundStatusLike;
  estateSegment?: string | null;
}

/** Provider confirmed the refund was processed: Dr 2200 / Cr 1100 (refunded out of the gateway balance). */
export function refundSettled(input: RefundSettledInput): JournalDraft {
  const { refund } = input;
  if (input.providerStatus !== 'processed') {
    throw new JournalError(
      `refund ${refund.id}: provider status is ${input.providerStatus}; settlement posts only when the provider reports processed`,
      { refundId: refund.id, providerStatus: input.providerStatus },
    );
  }
  if (refund.status !== 'submitted' && refund.status !== 'pending' && refund.status !== 'settled') {
    throw new JournalError(`refund ${refund.id} is ${refund.status}; it must be approved and submitted before it can settle`, {
      refundId: refund.id,
      status: refund.status,
    });
  }
  const amount = assertPositiveKobo('refund.amountKobo', refund.amountKobo);
  const entity = { entityType: 'refund', entityId: refund.id };
  return base(
    `refund:${refund.id}:settled`,
    `Refund ${refund.id} processed by the gateway`,
    'refund',
    refund.id,
    refund.currency,
    { organizationId: refund.organizationId, estateSegment: input.estateSegment },
    [
      debit(ACCOUNTS.REFUNDS_PAYABLE, amount, { ...entity, memo: 'Refund liability discharged' }),
      credit(ACCOUNTS.GATEWAY_CLEARING, amount, { ...entity, memo: 'Refunded from gateway balance' }),
    ],
  );
}

export interface ChargebackInput {
  chargeback: {
    id: string;
    paymentAttemptId: string;
    organizationId?: string | null;
    currency?: string;
    amountKobo: Kobo;
  };
  estateSegment?: string | null;
}

/** Dispute opened; gateway withholds the amount: Dr 2500 / Cr 1100. History is untouched. */
export function chargebackOpened(input: ChargebackInput): JournalDraft {
  const { chargeback } = input;
  const amount = assertPositiveKobo('chargeback.amountKobo', chargeback.amountKobo);
  const entity = { entityType: 'chargeback', entityId: chargeback.id };
  return base(
    `chargeback:${chargeback.id}:opened`,
    `Chargeback ${chargeback.id} opened on payment attempt ${chargeback.paymentAttemptId}`,
    'chargeback',
    chargeback.id,
    chargeback.currency,
    { organizationId: chargeback.organizationId, estateSegment: input.estateSegment },
    [
      debit(ACCOUNTS.CHARGEBACKS_PENDING, amount, { ...entity, memo: 'Disputed amount pending resolution' }),
      credit(ACCOUNTS.GATEWAY_CLEARING, amount, { ...entity, memo: 'Withheld by gateway pending dispute' }),
    ],
  );
}

/** Dispute lost: Dr 5100 / Cr 2500. */
export function chargebackLost(input: ChargebackInput): JournalDraft {
  const { chargeback } = input;
  const amount = assertPositiveKobo('chargeback.amountKobo', chargeback.amountKobo);
  const entity = { entityType: 'chargeback', entityId: chargeback.id };
  return base(
    `chargeback:${chargeback.id}:lost`,
    `Chargeback ${chargeback.id} lost`,
    'chargeback',
    chargeback.id,
    chargeback.currency,
    { organizationId: chargeback.organizationId, estateSegment: input.estateSegment },
    [
      debit(ACCOUNTS.REFUND_AND_CHARGEBACK_LOSSES, amount, { ...entity, memo: 'Chargeback loss' }),
      credit(ACCOUNTS.CHARGEBACKS_PENDING, amount, { ...entity, memo: 'Pending chargeback resolved as lost' }),
    ],
  );
}

/** Dispute won: reversal of the opening entry (Dr 1100 / Cr 2500). */
export function chargebackWon(input: ChargebackInput): JournalDraft {
  const opened = chargebackOpened(input);
  return reverse(opened, `chargeback:${input.chargeback.id}:won`, 'chargeback won; funds released by the gateway');
}

export interface CreditNoteIssuedInput {
  creditNote: {
    id: string;
    number?: string;
    invoiceId: string;
    organizationId: string;
    currency?: string;
    amountKobo: Kobo;
  };
  source: OriginalRecognition;
  revenueAccount?: RevenueAccount;
  estateSegment?: string | null;
}

/** Credit note: Dr revenue|2000|2100 / Cr receivable (1200, or 1300 for rent). */
export function creditNoteIssued(input: CreditNoteIssuedInput): JournalDraft {
  const { creditNote } = input;
  const amount = assertPositiveKobo('creditNote.amountKobo', creditNote.amountKobo);
  const from = recognitionAccount(input.source, input.revenueAccount ?? ACCOUNTS.SERVICE_REVENUE);
  const receivable = receivableAccount(input.source === 'rent_payable');
  const label = creditNote.number ?? creditNote.id;
  const entity = { entityType: 'credit_note', entityId: creditNote.id };
  return base(
    `credit_note:${creditNote.id}:issued`,
    `Credit note ${label} issued`,
    'credit_note',
    creditNote.id,
    creditNote.currency,
    { organizationId: creditNote.organizationId, estateSegment: input.estateSegment },
    [
      debit(from, amount, { ...entity, memo: `Credit note ${label} reduces ${input.source}` }),
      credit(receivable, amount, { entityType: 'invoice', entityId: creditNote.invoiceId, memo: `Credit note ${label} applied` }),
    ],
  );
}

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

export interface TaxWithheldInput {
  invoice: { id: string; number?: string; organizationId: string; currency?: string; estateSegment?: string | null };
  /** Amount the customer withheld at source and remits to the tax authority on our behalf. */
  withheldKobo: Kobo;
  /** Customer's withholding credit note / remittance evidence reference. */
  evidenceRef?: string;
}

/**
 * Customer withholding tax at source: Dr 2300 / Cr 1200. The receivable falls
 * by the withheld amount and the withholding credit offsets tax payable (the
 * accountant confirms the offset treatment; see docs/providers/accounting.md).
 */
export function taxWithheld(input: TaxWithheldInput): JournalDraft {
  const amount = assertPositiveKobo('withheldKobo', input.withheldKobo);
  const label = input.invoice.number ?? input.invoice.id;
  const entity = { entityType: 'invoice', entityId: input.invoice.id };
  return base(
    `invoice:${input.invoice.id}:withholding`,
    `Withholding tax deducted by customer on invoice ${label}${input.evidenceRef ? ` (${input.evidenceRef})` : ''}`,
    'invoice',
    input.invoice.id,
    input.invoice.currency,
    { organizationId: input.invoice.organizationId, estateSegment: input.invoice.estateSegment },
    [
      debit(ACCOUNTS.TAX_AND_WITHHOLDING_PAYABLE, amount, { ...entity, memo: 'Withholding credit' }),
      credit(ACCOUNTS.CUSTOMER_RECEIVABLES, amount, { ...entity, memo: `Withheld at source on ${label}` }),
    ],
  );
}

export interface TaxRemittedInput {
  remittance: { id: string; organizationId?: string | null; currency?: string; amountKobo: Kobo; period?: string };
}

/** Tax paid to the authority from the bank: Dr 2300 / Cr 1000. */
export function taxRemitted(input: TaxRemittedInput): JournalDraft {
  const { remittance } = input;
  const amount = assertPositiveKobo('remittance.amountKobo', remittance.amountKobo);
  const entity = { entityType: 'tax_remittance', entityId: remittance.id };
  return base(
    `tax_remittance:${remittance.id}:paid`,
    `Tax remitted${remittance.period ? ` for ${remittance.period}` : ''}`,
    'tax_remittance',
    remittance.id,
    remittance.currency,
    { organizationId: remittance.organizationId },
    [
      debit(ACCOUNTS.TAX_AND_WITHHOLDING_PAYABLE, amount, { ...entity, memo: 'Tax liability settled' }),
      credit(ACCOUNTS.BANK, amount, { ...entity, memo: 'Paid to tax authority' }),
    ],
  );
}

// ---------------------------------------------------------------------------
// Owners, partners, payouts
// ---------------------------------------------------------------------------

export type PayoutStatusLike = 'proposed' | 'first_approved' | 'approved' | 'submitted' | 'settled' | 'failed' | 'rejected';

export type ReconciliationStatusLike = 'open' | 'in_progress' | 'balanced' | 'exceptions' | 'closed';

export interface OwnerDistributionApprovedInput {
  payout: {
    id: string;
    organizationId: string;
    currency?: string;
    amountKobo: Kobo;
    status: PayoutStatusLike;
    ownerStatementId?: string | null;
  };
  /** The reconciliation the payout is gated on; must be balanced or closed. */
  reconciliation: { id: string; status: ReconciliationStatusLike };
  estateSegment?: string | null;
}

/**
 * Owner distribution approved by two different approvers after a balanced
 * reconciliation: Dr 2100 / Cr 2400. Nothing leaves the bank yet.
 */
export function ownerDistributionApproved(input: OwnerDistributionApprovedInput): JournalDraft {
  const { payout, reconciliation } = input;
  if (payout.status !== 'approved') {
    throw new JournalError(`payout ${payout.id} is ${payout.status}; distributions post only after both approvals (status approved)`, {
      payoutId: payout.id,
      status: payout.status,
    });
  }
  if (reconciliation.status !== 'balanced' && reconciliation.status !== 'closed') {
    throw new JournalError(`payout ${payout.id}: reconciliation ${reconciliation.id} is ${reconciliation.status}; payouts require a balanced reconciliation`, {
      payoutId: payout.id,
      reconciliationId: reconciliation.id,
      reconciliationStatus: reconciliation.status,
    });
  }
  const amount = assertPositiveKobo('payout.amountKobo', payout.amountKobo);
  const entity = { entityType: 'payout', entityId: payout.id };
  return base(
    `payout:${payout.id}:approved`,
    `Owner distribution ${payout.id} approved (reconciliation ${reconciliation.id})`,
    'payout',
    payout.id,
    payout.currency,
    { organizationId: payout.organizationId, estateSegment: input.estateSegment },
    [
      debit(ACCOUNTS.RENT_COLLECTED_PAYABLE_TO_OWNERS, amount, { ...entity, memo: 'Rent released for distribution' }),
      credit(ACCOUNTS.PARTNER_AND_SUPPLIER_PAYABLES, amount, { ...entity, memo: 'Distribution payable to owner' }),
    ],
  );
}

export interface OwnerPayoutSettledInput {
  payout: {
    id: string;
    organizationId: string;
    currency?: string;
    amountKobo: Kobo;
    status: PayoutStatusLike;
  };
  /** Bank statement line or transfer reference proving the money left the bank. */
  settlementReference: string;
  estateSegment?: string | null;
}

/** Payout confirmed by finance against the bank: Dr 2400 / Cr 1000. Also used for partner/supplier payables. */
export function ownerPayoutSettled(input: OwnerPayoutSettledInput): JournalDraft {
  const { payout } = input;
  if (!input.settlementReference || input.settlementReference.trim().length === 0) {
    throw new JournalError(`payout ${payout.id}: a bank settlement reference is required before the payout is settled`, {
      payoutId: payout.id,
    });
  }
  if (payout.status !== 'submitted' && payout.status !== 'settled') {
    throw new JournalError(`payout ${payout.id} is ${payout.status}; it must be approved and submitted before settlement`, {
      payoutId: payout.id,
      status: payout.status,
    });
  }
  const amount = assertPositiveKobo('payout.amountKobo', payout.amountKobo);
  const entity = { entityType: 'payout', entityId: payout.id };
  return base(
    `payout:${payout.id}:settled`,
    `Payout ${payout.id} settled (${input.settlementReference.trim()})`,
    'payout',
    payout.id,
    payout.currency,
    { organizationId: payout.organizationId, estateSegment: input.estateSegment },
    [
      debit(ACCOUNTS.PARTNER_AND_SUPPLIER_PAYABLES, amount, { ...entity, memo: 'Payable discharged' }),
      credit(ACCOUNTS.BANK, amount, { ...entity, memo: `Paid from bank (${input.settlementReference.trim()})` }),
    ],
  );
}

export interface ManagementFeeInput {
  statement: { id: string; organizationId: string; ownerOrganizationId?: string | null; currency?: string; period?: string };
  /** Rent actually collected in the period (basis for the fee). */
  collectedRentKobo: Kobo;
  /** Agreed fee in basis points, e.g. 1000 = 10%. */
  feeBps: number;
  /** Tax charged on the fee (e.g. VAT) in basis points; 0 when not applicable. */
  taxBps?: number;
  estateSegment?: string | null;
}

export function computeManagementFee(collectedRentKobo: Kobo, feeBps: number, taxBps = 0): { feeKobo: Kobo; taxKobo: Kobo } {
  const feeKobo = bpsOf(assertNonNegativeKobo('collectedRentKobo', collectedRentKobo), feeBps);
  const taxKobo = taxBps > 0 ? bpsOf(feeKobo, taxBps) : 0n;
  return { feeKobo, taxKobo };
}

/** Agreed management fee taken from rent collected for the owner: Dr 2100 fee (+tax) / Cr 4100 fee / Cr 2300 tax. */
export function managementFeeFromCollectedRent(input: ManagementFeeInput): JournalDraft {
  const { statement } = input;
  const { feeKobo, taxKobo } = computeManagementFee(input.collectedRentKobo, input.feeBps, input.taxBps ?? 0);
  if (feeKobo <= 0n) {
    throw new JournalError(`owner statement ${statement.id}: management fee rounds to zero (${input.feeBps} bps of ${input.collectedRentKobo})`, {
      statementId: statement.id,
    });
  }
  const entity = { entityType: 'owner_statement', entityId: statement.id };
  const lines: JournalLineDraft[] = [
    debit(ACCOUNTS.RENT_COLLECTED_PAYABLE_TO_OWNERS, feeKobo + taxKobo, {
      ...entity,
      memo: `Management fee ${input.feeBps} bps deducted from rent payable`,
      ...(statement.ownerOrganizationId ? { organizationId: statement.ownerOrganizationId } : {}),
    }),
    credit(ACCOUNTS.MANAGEMENT_FEE_REVENUE, feeKobo, { ...entity, memo: `Management fee earned${statement.period ? ` for ${statement.period}` : ''}` }),
  ];
  if (taxKobo > 0n) {
    lines.push(credit(ACCOUNTS.TAX_AND_WITHHOLDING_PAYABLE, taxKobo, { ...entity, memo: `Tax on management fee (${input.taxBps} bps)` }));
  }
  return base(
    `owner_statement:${statement.id}:management_fee`,
    `Management fee on rent collected${statement.period ? ` for ${statement.period}` : ''} (statement ${statement.id})`,
    'owner_statement',
    statement.id,
    statement.currency,
    { organizationId: statement.organizationId, estateSegment: input.estateSegment },
    lines,
  );
}

export interface MaintenanceExpenseInput {
  workOrder: {
    id: string;
    organizationId: string;
    currency?: string;
    amountKobo: Kobo;
    supplierOrganizationId?: string | null;
  };
  estateSegment?: string | null;
}

/** Verified maintenance work billed by a contractor: Dr 5200 / Cr 2400. */
export function maintenanceExpenseRecoverable(input: MaintenanceExpenseInput): JournalDraft {
  const { workOrder } = input;
  const amount = assertPositiveKobo('workOrder.amountKobo', workOrder.amountKobo);
  const entity = { entityType: 'work_order', entityId: workOrder.id };
  return base(
    `work_order:${workOrder.id}:expense`,
    `Maintenance expense for work order ${workOrder.id}`,
    'work_order',
    workOrder.id,
    workOrder.currency,
    { organizationId: workOrder.organizationId, estateSegment: input.estateSegment },
    [
      debit(ACCOUNTS.MAINTENANCE_AND_ESTATE_EXPENSES_RECOVERABLE, amount, { ...entity, memo: 'Recoverable maintenance expense' }),
      credit(ACCOUNTS.PARTNER_AND_SUPPLIER_PAYABLES, amount, {
        ...entity,
        memo: 'Owed to contractor',
        ...(workOrder.supplierOrganizationId ? { organizationId: workOrder.supplierOrganizationId } : {}),
      }),
    ],
  );
}

export interface MaintenanceRecoveredInput {
  workOrder: { id: string; organizationId: string; currency?: string; ownerOrganizationId?: string | null };
  /** Amount recovered from the owner's rent balance. */
  amountKobo: Kobo;
  estateSegment?: string | null;
}

/** Recovery of a maintenance expense from the owner's rent balance: Dr 2100 / Cr 5200. */
export function maintenanceExpenseRecovered(input: MaintenanceRecoveredInput): JournalDraft {
  const { workOrder } = input;
  const amount = assertPositiveKobo('amountKobo', input.amountKobo);
  const entity = { entityType: 'work_order', entityId: workOrder.id };
  return base(
    `work_order:${workOrder.id}:recovered`,
    `Maintenance expense for work order ${workOrder.id} recovered from owner`,
    'work_order',
    workOrder.id,
    workOrder.currency,
    { organizationId: workOrder.organizationId, estateSegment: input.estateSegment },
    [
      debit(ACCOUNTS.RENT_COLLECTED_PAYABLE_TO_OWNERS, amount, {
        ...entity,
        memo: 'Deducted from rent payable to owner',
        ...(workOrder.ownerOrganizationId ? { organizationId: workOrder.ownerOrganizationId } : {}),
      }),
      credit(ACCOUNTS.MAINTENANCE_AND_ESTATE_EXPENSES_RECOVERABLE, amount, { ...entity, memo: 'Expense recovered' }),
    ],
  );
}

export interface PartnerFeeAccruedInput {
  engagement: { id: string; organizationId: string; currency?: string; partnerOrganizationId?: string | null };
  amountKobo: Kobo;
  estateSegment?: string | null;
}

/** Partner professional fee accrued for an engagement: Dr 5300 / Cr 2400. Paid later via `ownerPayoutSettled`. */
export function partnerFeeAccrued(input: PartnerFeeAccruedInput): JournalDraft {
  const { engagement } = input;
  const amount = assertPositiveKobo('amountKobo', input.amountKobo);
  const entity = { entityType: 'service_request', entityId: engagement.id };
  return base(
    `partner_fee:${engagement.id}:accrued`,
    `Partner professional fee accrued for engagement ${engagement.id}`,
    'service_request',
    engagement.id,
    engagement.currency,
    { organizationId: engagement.organizationId, estateSegment: input.estateSegment },
    [
      debit(ACCOUNTS.PARTNER_PROFESSIONAL_FEES, amount, { ...entity, memo: 'Cost of service' }),
      credit(ACCOUNTS.PARTNER_AND_SUPPLIER_PAYABLES, amount, {
        ...entity,
        memo: 'Owed to partner',
        ...(engagement.partnerOrganizationId ? { organizationId: engagement.partnerOrganizationId } : {}),
      }),
    ],
  );
}
