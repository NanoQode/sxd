import { z } from 'zod';
import { expectedVersionSchema, isoDateTimeSchema, uuidSchema } from './common';
import { engagementStatusSchema } from './portal';
import { koboStringSchema } from './projects';

/**
 * Engagement triage, quotations and customer acceptance (build brief §8).
 * Money on the wire is integer kobo as decimal strings; the server recomputes
 * every line amount, subtotal, tax and total from the lines it stores.
 */

export const quoteStatusSchema = z.enum([
  'draft',
  'issued',
  'accepted',
  'rejected',
  'expired',
  'superseded',
  'withdrawn',
]);
export type QuoteStatus = z.infer<typeof quoteStatusSchema>;

/** Quantities travel as decimal strings with up to three places (hours, units, visits). */
export const quantityStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'decimal quantity with up to three places');

export const quoteLineInputSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: quantityStringSchema.default('1'),
  unitAmountKobo: koboStringSchema,
  /** Optional per-line override; the tax treatment supplies the default rate. */
  taxRateBps: z.number().int().min(0).max(10_000).optional(),
  accountCode: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
});
export type QuoteLineInput = z.infer<typeof quoteLineInputSchema>;

export const quoteLineDtoSchema = z.object({
  description: z.string(),
  quantity: z.string(),
  unitAmountKobo: z.string(),
  amountKobo: z.string(),
  taxRateBps: z.number().int().optional(),
  accountCode: z.string().optional(),
});

export const feeBasisSchema = z.object({
  percentageBps: z.number().int().min(0).max(10_000).optional(),
  basisDescription: z.string().trim().max(1000).optional(),
  /** Basis amount the percentage applies to (e.g. agreed purchase price), integer kobo. */
  basisAmountKobo: koboStringSchema.optional(),
  /** What the basis amount is: the agreed purchase price or an explicit cap agreed with the customer. */
  basisKind: z.enum(['agreed_purchase_price', 'agreed_cap']).optional(),
  /** File on the service request holding the customer-signed scope (required for percentage fees). */
  signedScopeFileId: uuidSchema.optional(),
});
export type FeeBasis = z.infer<typeof feeBasisSchema>;

export const triageRequestSchema = z.object({
  assignedPmUserId: z.string().min(1).max(64),
  priority: z.number().int().min(1).max(5).default(3),
  /** Overrides the SLA policy for the service; otherwise computed from sla_policies. */
  slaDueAt: isoDateTimeSchema.optional(),
  note: z.string().trim().max(4000).optional(),
  expectedVersion: expectedVersionSchema,
});
export type TriageRequest = z.infer<typeof triageRequestSchema>;

export const assignRequestSchema = z.object({
  assignedPmUserId: z.string().min(1).max(64),
  /** When true and the request is accepted, work starts without upfront payment. */
  startWork: z.boolean().default(false),
  reason: z.string().trim().max(2000).optional(),
  expectedVersion: expectedVersionSchema,
});
export type AssignRequest = z.infer<typeof assignRequestSchema>;

/** Staff transitions: reject, pause, resume, cancel, or an override into in_progress. */
export const staffTransitionTargetSchema = z.enum([
  'rejected',
  'paused',
  'in_progress',
  'cancelled',
  'in_review',
  'delivered',
  'completed',
]);

export const staffTransitionSchema = z.object({
  to: staffTransitionTargetSchema,
  reason: z.string().trim().max(2000).optional(),
  /** Billing consequence recorded with the transition, e.g. void_unpaid_invoices. */
  billingConsequence: z
    .enum(['none', 'void_unpaid_invoices', 'invoice_pro_rata', 'refund_per_policy'])
    .optional(),
  expectedVersion: expectedVersionSchema,
});
export type StaffTransition = z.infer<typeof staffTransitionSchema>;

const quoteVersionBase = {
  scopeMarkdown: z.string().trim().max(20_000).optional(),
  exclusions: z.string().trim().max(8000).optional(),
  taxTreatmentKey: z.string().max(64).optional(),
  validUntil: isoDateTimeSchema.optional(),
  currency: z.string().length(3).default('NGN'),
  feeBasis: feeBasisSchema.optional(),
  /** Deposit percentage of the total invoiced on acceptance; 0 means no upfront payment. */
  depositBps: z.number().int().min(0).max(10_000).default(10_000),
  /** When false the engagement starts without an upfront invoice. */
  requiresPayment: z.boolean().default(true),
  installmentPlan: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(120),
        amountKobo: koboStringSchema,
        dueDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
    )
    .max(24)
    .optional(),
};

export const quoteCreateSchema = z
  .object({
    templateId: uuidSchema.optional(),
    lines: z.array(quoteLineInputSchema).min(1).max(100).optional(),
    ...quoteVersionBase,
  })
  .refine(
    (v) =>
      Boolean(v.templateId) ||
      (v.lines && v.lines.length > 0) ||
      // Percentage fees derive their single line from the agreed basis on the server.
      Boolean(v.feeBasis?.percentageBps && v.feeBasis.basisAmountKobo),
    {
      message: 'provide a templateId, at least one line, or a percentage fee basis',
      path: ['lines'],
    },
  );
export type QuoteCreate = z.infer<typeof quoteCreateSchema>;

export const quoteVersionCreateSchema = z.object({
  lines: z.array(quoteLineInputSchema).min(1).max(100),
  ...quoteVersionBase,
});
export type QuoteVersionCreate = z.infer<typeof quoteVersionCreateSchema>;

export const quoteIssueSchema = z.object({
  validUntil: isoDateTimeSchema.optional(),
  /** Defaults to 14 days when validUntil is omitted. */
  validDays: z.number().int().min(1).max(180).optional(),
});
export type QuoteIssue = z.infer<typeof quoteIssueSchema>;

export const quoteAcceptSchema = z.object({
  quoteVersionId: uuidSchema,
  signatureName: z.string().trim().min(2).max(160),
  termsVersion: z.string().trim().min(1).max(32),
  acceptTerms: z.literal(true),
});
export type QuoteAccept = z.infer<typeof quoteAcceptSchema>;

export const quoteRejectSchema = z.object({
  quoteVersionId: uuidSchema,
  reason: z.string().trim().min(3).max(2000),
});
export type QuoteReject = z.infer<typeof quoteRejectSchema>;

export const quoteVersionDtoSchema = z.object({
  id: uuidSchema,
  version: z.number().int(),
  lines: z.array(quoteLineDtoSchema),
  subtotalKobo: z.string(),
  taxKobo: z.string(),
  totalKobo: z.string(),
  currency: z.string(),
  scopeMarkdown: z.string().nullable(),
  exclusions: z.string().nullable(),
  validUntil: isoDateTimeSchema.nullable(),
  feeBasis: z.unknown().nullable(),
  taxTreatmentKey: z.string().nullable(),
  issuedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type QuoteVersionDto = z.infer<typeof quoteVersionDtoSchema>;

export const quoteDtoSchema = z.object({
  id: uuidSchema,
  serviceRequestId: uuidSchema,
  organizationId: z.string(),
  status: quoteStatusSchema,
  currentVersion: z.number().int(),
  versions: z.array(quoteVersionDtoSchema),
  acceptance: z
    .object({
      quoteVersionId: uuidSchema,
      acceptedByUserId: z.string(),
      acceptedAt: isoDateTimeSchema,
      signatureName: z.string(),
      termsVersion: z.string(),
    })
    .nullable(),
  invoiceId: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type QuoteDto = z.infer<typeof quoteDtoSchema>;

export const engagementTransitionResultSchema = z.object({
  id: uuidSchema,
  reference: z.string(),
  status: engagementStatusSchema,
  version: z.number().int(),
  assignedPmUserId: z.string().nullable(),
  priority: z.number().int(),
  slaDueAt: isoDateTimeSchema.nullable(),
});
export type EngagementTransitionResult = z.infer<typeof engagementTransitionResultSchema>;
