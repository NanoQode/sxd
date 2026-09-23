import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  currency,
  id,
  jsonObject,
  kobo,
  koboNotNull,
  koboZero,
  timestamps,
  tstz,
  version,
} from './_common';
import { organization, user } from './auth';

export const ledgerAccountTypeEnum = pgEnum('ledger_account_type', [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
]);

export const normalBalanceEnum = pgEnum('normal_balance', ['debit', 'credit']);

export const invoiceKindEnum = pgEnum('invoice_kind', [
  'service',
  'deposit',
  'installment',
  'management_fee',
  'rent',
  'service_charge',
  'tender_fee',
  'procurement',
  'other',
]);

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'draft',
  'issued',
  'partially_paid',
  'paid',
  'overdue',
  'void',
]);

export const paymentProviderEnum = pgEnum('payment_provider', ['paystack', 'bank_transfer', 'dev']);

export const paymentAttemptStatusEnum = pgEnum('payment_attempt_status', [
  'initialized',
  'pending',
  'successful',
  'failed',
  'reversed',
  'uncertain',
  'abandoned',
]);

export const providerEventStatusEnum = pgEnum('provider_event_status', [
  'received',
  'queued',
  'processed',
  'ignored',
  'failed',
]);

export const bankReceiptStatusEnum = pgEnum('bank_receipt_status', [
  'submitted',
  'under_review',
  'confirmed',
  'rejected',
]);

export const creditNoteStatusEnum = pgEnum('credit_note_status', [
  'draft',
  'issued',
  'applied',
  'void',
]);

export const refundStatusEnum = pgEnum('refund_status', [
  'requested',
  'approved',
  'submitted',
  'pending',
  'settled',
  'failed',
  'rejected',
]);

export const chargebackStatusEnum = pgEnum('chargeback_status', [
  'opened',
  'evidence_submitted',
  'won',
  'lost',
  'closed',
]);

export const reconciliationStatusEnum = pgEnum('reconciliation_status', [
  'open',
  'in_progress',
  'balanced',
  'exceptions',
  'closed',
]);

export const payoutStatusEnum = pgEnum('payout_status', [
  'proposed',
  'first_approved',
  'approved',
  'submitted',
  'settled',
  'failed',
  'rejected',
]);

export const ledgerAccounts = pgTable('ledger_accounts', {
  id: id(),
  code: text().notNull().unique(),
  name: text().notNull(),
  type: ledgerAccountTypeEnum().notNull(),
  subtype: text(),
  normalBalance: normalBalanceEnum().notNull(),
  isControl: boolean().notNull().default(false),
  description: text(),
  active: boolean().notNull().default(true),
  createdAt: createdAt(),
});

/** Append-only journals; corrections are reversing journals. */
export const journals = pgTable(
  'journals',
  {
    id: id(),
    organizationId: text().references(() => organization.id),
    businessEventRef: text().notNull().unique(),
    description: text().notNull(),
    sourceType: text().notNull(),
    sourceId: uuid(),
    postedAt: createdAt(),
    postedBy: text(),
    reversalOfJournalId: uuid(),
    estateSegment: text(),
    createdAt: createdAt(),
  },
  (t) => [index('journals_source_idx').on(t.sourceType, t.sourceId)],
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: id(),
    journalId: uuid()
      .notNull()
      .references(() => journals.id),
    lineNo: integer().notNull(),
    accountId: uuid()
      .notNull()
      .references(() => ledgerAccounts.id),
    debitKobo: koboZero(),
    creditKobo: koboZero(),
    currency: currency(),
    organizationId: text().references(() => organization.id),
    entityType: text(),
    entityId: uuid(),
    memo: text(),
  },
  (t) => [
    uniqueIndex('journal_lines_unique').on(t.journalId, t.lineNo),
    index('journal_lines_account_idx').on(t.accountId),
    check('journal_lines_non_negative', sql`${t.debitKobo} >= 0 AND ${t.creditKobo} >= 0`),
    check('journal_lines_one_side', sql`${t.debitKobo} = 0 OR ${t.creditKobo} = 0`),
  ],
);

export const taxTreatments = pgTable('tax_treatments', {
  id: id(),
  key: text().notNull().unique(),
  name: text().notNull(),
  rateBps: integer().notNull().default(0),
  withholdingBps: integer().notNull().default(0),
  appliesTo: text().notNull().default('all'),
  reviewedBy: text().references(() => user.id),
  reviewedAt: tstz(),
  active: boolean().notNull().default(true),
  note: text(),
  ...timestamps(),
});

export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    number: text().notNull().unique(),
    kind: invoiceKindEnum().notNull().default('service'),
    status: invoiceStatusEnum().notNull().default('draft'),
    serviceRequestId: uuid(),
    projectId: uuid(),
    milestoneId: uuid(),
    leaseId: uuid(),
    quoteVersionId: uuid(),
    customerUserId: text().references(() => user.id),
    currency: currency(),
    subtotalKobo: koboNotNull(),
    taxKobo: koboZero(),
    withholdingKobo: koboZero(),
    totalKobo: koboNotNull(),
    amountPaidKobo: koboZero(),
    amountCreditedKobo: koboZero(),
    taxTreatmentKey: text(),
    taxTreatmentSnapshot: jsonb(),
    dueDate: date({ mode: 'string' }),
    issuedAt: tstz(),
    issuedBy: text().references(() => user.id),
    paidAt: tstz(),
    voidedAt: tstz(),
    voidReason: text(),
    voidedBy: text().references(() => user.id),
    notes: text(),
    isRentOnBehalfOfOwner: boolean().notNull().default(false),
    ownerOrganizationId: text().references(() => organization.id),
    estateSegment: text(),
    installmentPlan: jsonb(),
    createdBy: text().references(() => user.id),
    version: version(),
    ...timestamps(),
  },
  (t) => [
    index('invoices_org_idx').on(t.organizationId, t.status),
    index('invoices_due_idx').on(t.status, t.dueDate),
    check('invoices_amounts_non_negative', sql`${t.totalKobo} >= 0 AND ${t.amountPaidKobo} >= 0`),
  ],
);

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: id(),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    description: text().notNull(),
    quantity: numeric({ precision: 12, scale: 3 }).notNull().default('1'),
    unitAmountKobo: koboNotNull(),
    amountKobo: koboNotNull(),
    taxRateBps: integer().notNull().default(0),
    taxKobo: koboZero(),
    accountCode: text(),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [index('invoice_lines_invoice_idx').on(t.invoiceId)],
);

export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id),
    provider: paymentProviderEnum().notNull(),
    environment: text().notNull().default('test'),
    /** Our immutable reference, sent to the provider. */
    reference: text().notNull().unique(),
    providerReference: text(),
    amountKobo: koboNotNull(),
    currency: currency(),
    status: paymentAttemptStatusEnum().notNull().default('initialized'),
    channel: text(),
    authorizationUrl: text(),
    accessCode: text(),
    initiatedByUserId: text().references(() => user.id),
    providerResponseSanitized: jsonb(),
    verifiedAt: tstz(),
    settledAt: tstz(),
    failureReason: text(),
    feesKobo: kobo(),
    idempotencyKey: text(),
    lastReconciledAt: tstz(),
    version: version(),
    ...timestamps(),
  },
  (t) => [
    index('payment_attempts_invoice_idx').on(t.invoiceId, t.status),
    index('payment_attempts_provider_ref_idx').on(t.provider, t.providerReference),
  ],
);

/** Durable, deduplicated record of provider callbacks and webhooks. */
export const providerEvents = pgTable(
  'provider_events',
  {
    id: id(),
    provider: text().notNull(),
    environment: text().notNull().default('test'),
    dedupeKey: text().notNull().unique(),
    providerEventId: text(),
    eventType: text().notNull(),
    reference: text(),
    signatureValid: boolean().notNull(),
    rawBody: text().notNull(),
    headersSanitized: jsonb(),
    receivedAt: createdAt(),
    processingStatus: providerEventStatusEnum().notNull().default('received'),
    processedAt: tstz(),
    processingError: text(),
    attempts: integer().notNull().default(0),
  },
  (t) => [index('provider_events_reference_idx').on(t.provider, t.reference)],
);

export const bankTransferReceipts = pgTable(
  'bank_transfer_receipts',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id),
    uploadedFileId: uuid(),
    declaredAmountKobo: koboNotNull(),
    declaredPaidAt: date({ mode: 'string' }),
    bankReference: text(),
    status: bankReceiptStatusEnum().notNull().default('submitted'),
    submittedBy: text().references(() => user.id),
    reviewedBy: text().references(() => user.id),
    reviewedAt: tstz(),
    reviewNote: text(),
    paymentAttemptId: uuid().references(() => paymentAttempts.id),
    ...timestamps(),
  },
  (t) => [index('bank_transfer_receipts_invoice_idx').on(t.invoiceId, t.status)],
);

export const creditNotes = pgTable(
  'credit_notes',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id),
    number: text().notNull().unique(),
    amountKobo: koboNotNull(),
    currency: currency(),
    reason: text().notNull(),
    status: creditNoteStatusEnum().notNull().default('draft'),
    issuedBy: text().references(() => user.id),
    issuedAt: tstz(),
    journalId: uuid(),
    ...timestamps(),
  },
  (t) => [index('credit_notes_invoice_idx').on(t.invoiceId)],
);

/** Money applied to invoices from successful attempts, confirmed receipts or credit notes. */
export const allocations = pgTable(
  'allocations',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id),
    paymentAttemptId: uuid().references(() => paymentAttempts.id),
    bankReceiptId: uuid().references(() => bankTransferReceipts.id),
    creditNoteId: uuid().references(() => creditNotes.id),
    amountKobo: koboNotNull(),
    currency: currency(),
    dedupeKey: text().notNull().unique(),
    journalId: uuid(),
    allocatedAt: createdAt(),
    allocatedBy: text(),
  },
  (t) => [
    index('allocations_invoice_idx').on(t.invoiceId),
    check('allocations_positive', sql`${t.amountKobo} > 0`),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    paymentAttemptId: uuid()
      .notNull()
      .references(() => paymentAttempts.id),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id),
    amountKobo: koboNotNull(),
    currency: currency(),
    status: refundStatusEnum().notNull().default('requested'),
    reason: text().notNull(),
    requestedBy: text().references(() => user.id),
    approvedBy: text().references(() => user.id),
    approvedAt: tstz(),
    submittedAt: tstz(),
    providerReference: text(),
    providerStatus: text(),
    settledAt: tstz(),
    failureReason: text(),
    journalId: uuid(),
    settlementJournalId: uuid(),
    idempotencyKey: text(),
    version: version(),
    ...timestamps(),
  },
  (t) => [index('refunds_attempt_idx').on(t.paymentAttemptId)],
);

export const chargebacks = pgTable(
  'chargebacks',
  {
    id: id(),
    paymentAttemptId: uuid()
      .notNull()
      .references(() => paymentAttempts.id),
    providerReference: text(),
    amountKobo: koboNotNull(),
    currency: currency(),
    status: chargebackStatusEnum().notNull().default('opened'),
    openedAt: createdAt(),
    evidenceDueAt: tstz(),
    resolvedAt: tstz(),
    reconciliationTaskId: uuid(),
    journalId: uuid(),
    notes: text(),
  },
  (t) => [index('chargebacks_attempt_idx').on(t.paymentAttemptId)],
);

export const reconciliations = pgTable('reconciliations', {
  id: id(),
  kind: text().notNull(),
  periodStart: date({ mode: 'string' }).notNull(),
  periodEnd: date({ mode: 'string' }).notNull(),
  status: reconciliationStatusEnum().notNull().default('open'),
  summary: jsonb(),
  exceptions:
    jsonObject<Array<{ code: string; message: string; entityType?: string; entityId?: string }>>(),
  performedBy: text().references(() => user.id),
  closedAt: tstz(),
  ...timestamps(),
});

export const payouts = pgTable(
  'payouts',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    kind: text().notNull(),
    amountKobo: koboNotNull(),
    currency: currency(),
    status: payoutStatusEnum().notNull().default('proposed'),
    beneficiary: jsonb(),
    ownerStatementId: uuid(),
    reconciliationId: uuid().references(() => reconciliations.id),
    proposedBy: text().references(() => user.id),
    firstApproverId: text().references(() => user.id),
    firstApprovedAt: tstz(),
    secondApproverId: text().references(() => user.id),
    secondApprovedAt: tstz(),
    submittedAt: tstz(),
    settledAt: tstz(),
    failureReason: text(),
    journalId: uuid(),
    ...timestamps(),
  },
  (t) => [index('payouts_org_idx').on(t.organizationId, t.status)],
);

export const receipts = pgTable(
  'receipts',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id),
    allocationId: uuid()
      .notNull()
      .unique()
      .references(() => allocations.id),
    number: text().notNull().unique(),
    amountKobo: koboNotNull(),
    issuedAt: createdAt(),
    fileId: uuid(),
  },
  (t) => [index('receipts_invoice_idx').on(t.invoiceId)],
);
