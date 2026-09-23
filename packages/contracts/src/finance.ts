import { z } from 'zod';
import {
  cursorPaginationQuerySchema,
  dateOnlySchema,
  isoDateTimeSchema,
  uuidSchema,
} from './common';
import { koboStringSchema } from './projects';

/**
 * Invoices, payment attempts, receipts, refunds, bank transfers, credit notes
 * and reconciliation (build brief §12). All money is integer kobo as decimal
 * strings on the wire and bigint in the database. Responses never carry
 * provider secrets or raw provider payloads.
 */

export const invoiceKindSchema = z.enum([
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
export type InvoiceKind = z.infer<typeof invoiceKindSchema>;

export const invoiceStatusSchema = z.enum([
  'draft',
  'issued',
  'partially_paid',
  'paid',
  'overdue',
  'void',
]);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

export const paymentAttemptStatusSchema = z.enum([
  'initialized',
  'pending',
  'successful',
  'failed',
  'reversed',
  'uncertain',
  'abandoned',
]);
export type PaymentAttemptStatus = z.infer<typeof paymentAttemptStatusSchema>;

export const refundStatusSchema = z.enum([
  'requested',
  'approved',
  'submitted',
  'pending',
  'settled',
  'failed',
  'rejected',
]);
export type RefundStatus = z.infer<typeof refundStatusSchema>;

export const bankReceiptStatusSchema = z.enum([
  'submitted',
  'under_review',
  'confirmed',
  'rejected',
]);

export const installmentSchema = z.object({
  label: z.string().trim().min(1).max(120),
  amountKobo: koboStringSchema,
  dueDate: dateOnlySchema.optional(),
});
export type Installment = z.infer<typeof installmentSchema>;

export const invoiceLineInputSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z
    .string()
    .regex(/^\d+(\.\d{1,3})?$/)
    .default('1'),
  unitAmountKobo: koboStringSchema,
  taxRateBps: z.number().int().min(0).max(10_000).optional(),
  accountCode: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
});
export type InvoiceLineInput = z.infer<typeof invoiceLineInputSchema>;

/** Finance creates an invoice manually (milestone, management fee, other). */
export const invoiceCreateSchema = z.object({
  organizationId: z.string().min(1).max(64),
  customerUserId: z.string().min(1).max(64).optional(),
  kind: invoiceKindSchema.default('service'),
  serviceRequestId: uuidSchema.optional(),
  projectId: uuidSchema.optional(),
  milestoneId: uuidSchema.optional(),
  quoteVersionId: uuidSchema.optional(),
  lines: z.array(invoiceLineInputSchema).min(1).max(200),
  currency: z.string().length(3).default('NGN'),
  taxTreatmentKey: z.string().max(64).optional(),
  dueDate: dateOnlySchema.optional(),
  notes: z.string().trim().max(4000).optional(),
  installmentPlan: z.array(installmentSchema).max(24).optional(),
  /** Issue immediately instead of leaving a draft. */
  issue: z.boolean().default(false),
});
export type InvoiceCreate = z.infer<typeof invoiceCreateSchema>;

export const invoiceIssueSchema = z.object({
  dueDate: dateOnlySchema.optional(),
  expectedVersion: z.number().int().min(1).optional(),
});

export const invoiceVoidSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
});

export const invoiceListQuerySchema = cursorPaginationQuerySchema.extend({
  status: invoiceStatusSchema.optional(),
  organizationId: z.string().max(64).optional(),
  serviceRequestId: uuidSchema.optional(),
});
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;

export const invoiceLineDtoSchema = z.object({
  id: uuidSchema,
  description: z.string(),
  quantity: z.string(),
  unitAmountKobo: z.string(),
  amountKobo: z.string(),
  taxRateBps: z.number().int(),
  taxKobo: z.string(),
  accountCode: z.string().nullable(),
});

export const invoiceDtoSchema = z.object({
  id: uuidSchema,
  number: z.string(),
  organizationId: z.string(),
  kind: invoiceKindSchema,
  status: invoiceStatusSchema,
  serviceRequestId: uuidSchema.nullable(),
  quoteVersionId: uuidSchema.nullable(),
  customerUserId: z.string().nullable(),
  currency: z.string(),
  subtotalKobo: z.string(),
  taxKobo: z.string(),
  withholdingKobo: z.string(),
  totalKobo: z.string(),
  amountPaidKobo: z.string(),
  amountCreditedKobo: z.string(),
  balanceKobo: z.string(),
  taxTreatmentKey: z.string().nullable(),
  dueDate: z.string().nullable(),
  issuedAt: isoDateTimeSchema.nullable(),
  paidAt: isoDateTimeSchema.nullable(),
  voidedAt: isoDateTimeSchema.nullable(),
  voidReason: z.string().nullable(),
  notes: z.string().nullable(),
  installmentPlan: z.array(installmentSchema).nullable(),
  lines: z.array(invoiceLineDtoSchema),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type InvoiceDto = z.infer<typeof invoiceDtoSchema>;

export const paymentAttemptCreateSchema = z.object({
  /** Pay a specific installment (index into installmentPlan) instead of the full balance. */
  installmentIndex: z.number().int().min(0).max(23).optional(),
  /** Partial amount permitted only when it matches an installment or the balance. */
  amountKobo: koboStringSchema.optional(),
  channels: z
    .array(z.enum(['card', 'bank', 'bank_transfer', 'ussd', 'qr', 'mobile_money', 'eft']))
    .max(7)
    .optional(),
});
export type PaymentAttemptCreate = z.infer<typeof paymentAttemptCreateSchema>;

export const paymentAttemptDtoSchema = z.object({
  id: uuidSchema,
  invoiceId: uuidSchema,
  organizationId: z.string(),
  provider: z.enum(['paystack', 'bank_transfer', 'dev']),
  environment: z.string(),
  reference: z.string(),
  amountKobo: z.string(),
  currency: z.string(),
  status: paymentAttemptStatusSchema,
  channel: z.string().nullable(),
  authorizationUrl: z.string().nullable(),
  accessCode: z.string().nullable(),
  verifiedAt: isoDateTimeSchema.nullable(),
  settledAt: isoDateTimeSchema.nullable(),
  failureReason: z.string().nullable(),
  feesKobo: z.string().nullable(),
  /** Present when the dev adapter is in use so the UI can label it. */
  developmentAdapter: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type PaymentAttemptDto = z.infer<typeof paymentAttemptDtoSchema>;

export const paymentVerifyResultSchema = z.object({
  attempt: paymentAttemptDtoSchema,
  decision: z.enum([
    'settle',
    'fail',
    'keep_pending',
    'mark_uncertain',
    'mismatch',
    'reverse',
    'no_change',
  ]),
  invoiceStatus: invoiceStatusSchema,
  receiptNumber: z.string().nullable(),
  /** Customer-safe explanation; never provider internals. */
  message: z.string(),
});
export type PaymentVerifyResult = z.infer<typeof paymentVerifyResultSchema>;

export const receiptDtoSchema = z.object({
  id: uuidSchema,
  number: z.string(),
  invoiceId: uuidSchema,
  invoiceNumber: z.string(),
  organizationId: z.string(),
  allocationId: uuidSchema,
  amountKobo: z.string(),
  currency: z.string(),
  source: z.enum(['gateway', 'bank_transfer', 'credit_note']),
  issuedAt: isoDateTimeSchema,
});
export type ReceiptDto = z.infer<typeof receiptDtoSchema>;

export const bankTransferReceiptCreateSchema = z.object({
  declaredAmountKobo: koboStringSchema,
  declaredPaidAt: dateOnlySchema.optional(),
  bankReference: z.string().trim().min(2).max(120).optional(),
  uploadedFileId: uuidSchema.optional(),
});
export type BankTransferReceiptCreate = z.infer<typeof bankTransferReceiptCreateSchema>;

export const bankTransferConfirmSchema = z.object({
  /** Amount seen on the bank statement; may differ from the declared amount. */
  confirmedAmountKobo: koboStringSchema,
  note: z.string().trim().max(2000).optional(),
});

export const bankTransferRejectSchema = z.object({
  note: z.string().trim().min(3).max(2000),
});

export const bankTransferReceiptDtoSchema = z.object({
  id: uuidSchema,
  invoiceId: uuidSchema,
  organizationId: z.string(),
  declaredAmountKobo: z.string(),
  declaredPaidAt: z.string().nullable(),
  bankReference: z.string().nullable(),
  uploadedFileId: uuidSchema.nullable(),
  status: bankReceiptStatusSchema,
  reviewNote: z.string().nullable(),
  reviewedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type BankTransferReceiptDto = z.infer<typeof bankTransferReceiptDtoSchema>;

export const refundRequestSchema = z.object({
  paymentAttemptId: uuidSchema,
  /** Omit for a full refund of the attempt. */
  amountKobo: koboStringSchema.optional(),
  reason: z.string().trim().min(3).max(2000),
});
export type RefundRequest = z.infer<typeof refundRequestSchema>;

export const refundDecisionSchema = z.object({
  reason: z.string().trim().max(2000).optional(),
});

export const refundDtoSchema = z.object({
  id: uuidSchema,
  paymentAttemptId: uuidSchema,
  invoiceId: uuidSchema,
  organizationId: z.string(),
  amountKobo: z.string(),
  currency: z.string(),
  status: refundStatusSchema,
  reason: z.string(),
  requestedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: isoDateTimeSchema.nullable(),
  submittedAt: isoDateTimeSchema.nullable(),
  settledAt: isoDateTimeSchema.nullable(),
  failureReason: z.string().nullable(),
  providerStatus: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type RefundDto = z.infer<typeof refundDtoSchema>;

export const creditNoteCreateSchema = z.object({
  amountKobo: koboStringSchema,
  reason: z.string().trim().min(3).max(2000),
});

export const creditNoteDtoSchema = z.object({
  id: uuidSchema,
  number: z.string(),
  invoiceId: uuidSchema,
  organizationId: z.string(),
  amountKobo: z.string(),
  currency: z.string(),
  reason: z.string(),
  status: z.enum(['draft', 'issued', 'applied', 'void']),
  issuedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type CreditNoteDto = z.infer<typeof creditNoteDtoSchema>;

export const reconciliationAttemptsQuerySchema = cursorPaginationQuerySchema.extend({
  status: paymentAttemptStatusSchema.optional(),
  environment: z.enum(['test', 'live']).optional(),
});

export const reconciliationExceptionDtoSchema = z.object({
  reconciliationId: uuidSchema,
  periodStart: z.string(),
  status: z.enum(['open', 'in_progress', 'balanced', 'exceptions', 'closed']),
  code: z.string(),
  message: z.string(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
});
export type ReconciliationExceptionDto = z.infer<typeof reconciliationExceptionDtoSchema>;

export const webhookAckSchema = z.object({
  received: z.boolean(),
  duplicate: z.boolean(),
});

export const allocationsExportQuerySchema = z.object({
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  organizationId: z.string().max(64).optional(),
});
export type AllocationsExportQuery = z.infer<typeof allocationsExportQuerySchema>;
