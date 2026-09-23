import { z } from 'zod';
import { cursorPaginationQuerySchema, isoDateTimeSchema, uuidSchema } from './common';
import { conversationDetailSchema, userIdSchema } from './collaboration';
import { discrepancyDtoSchema } from './commercial';
import { koboStringSchema } from './projects';
import { payoutStatusSchema } from './rentals';

/**
 * Partner-workspace operations that close the loop on work staff hand to
 * partners: replying to delivery discrepancies, ad-hoc site visits, reviewer
 * selection, partner-initiated conversations and partner invoices that flow
 * into the two-approver payout process (build brief §3, §8, §10, §12).
 */

/* ---------------------------------------------------------------------- */
/* Delivery discrepancies: supplier response and staff decision            */
/* ---------------------------------------------------------------------- */

export const discrepancyProposedResolutionSchema = z.enum(['replace', 'credit', 'dispute']);
export type DiscrepancyProposedResolution = z.infer<typeof discrepancyProposedResolutionSchema>;

export const discrepancyRespondSchema = z.object({
  response: z.string().trim().min(3).max(4000),
  proposedResolution: discrepancyProposedResolutionSchema,
  /** Files the supplier uploaded (`partner_submission` or `evidence` purpose); linked as delivery evidence. */
  evidenceFileIds: z.array(uuidSchema).max(20).default([]),
});
export type DiscrepancyRespond = z.infer<typeof discrepancyRespondSchema>;

export const discrepancyOutcomeSchema = z.enum(['resolved', 'credited', 'returned']);
export type DiscrepancyOutcome = z.infer<typeof discrepancyOutcomeSchema>;

export const discrepancyDecideSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  reason: z.string().trim().min(3).max(4000),
  /** Closing status on accept; defaults from the supplier's proposal (credit → credited, otherwise resolved). */
  outcome: discrepancyOutcomeSchema.optional(),
});
export type DiscrepancyDecide = z.infer<typeof discrepancyDecideSchema>;

export const discrepancyThreadEntrySchema = z.object({
  id: uuidSchema,
  discrepancyId: uuidSchema,
  kind: z.enum(['supplier_response', 'staff_decision']),
  authorUserId: z.string(),
  authorName: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  /** Supplier response text, or the staff decision reason. */
  text: z.string(),
  proposedResolution: discrepancyProposedResolutionSchema.nullable(),
  evidenceFileIds: z.array(uuidSchema),
  decision: z.enum(['accept', 'reject']).nullable(),
  outcome: discrepancyOutcomeSchema.nullable(),
});
export type DiscrepancyThreadEntry = z.infer<typeof discrepancyThreadEntrySchema>;

/**
 * Where the exchange stands: `awaiting_supplier` (nothing from the supplier
 * yet), `responded` (supplier replied, staff decision pending), `rejected`
 * (staff refused the proposal; the supplier may reply again), `accepted`
 * (closed on the supplier's proposal) or `closed` (staff closed it without a
 * supplier response).
 */
export const discrepancyResponseStateSchema = z.enum([
  'awaiting_supplier',
  'responded',
  'rejected',
  'accepted',
  'closed',
]);
export type DiscrepancyResponseState = z.infer<typeof discrepancyResponseStateSchema>;

export const discrepancyThreadDtoSchema = z.object({
  discrepancy: discrepancyDtoSchema,
  responseState: discrepancyResponseStateSchema,
  entries: z.array(discrepancyThreadEntrySchema),
  /** The caller is the supplier and the discrepancy still takes a response. */
  canRespond: z.boolean(),
  /** The caller is staff and a supplier response awaits a decision. */
  canDecide: z.boolean(),
});
export type DiscrepancyThreadDto = z.infer<typeof discrepancyThreadDtoSchema>;

export const discrepancyThreadsResponseSchema = z.object({
  items: z.array(discrepancyThreadDtoSchema),
});

/* ---------------------------------------------------------------------- */
/* Unscheduled site visits                                                 */
/* ---------------------------------------------------------------------- */

export const siteVisitUnscheduledStartSchema = z.object({
  /** Why the inspector is on site without a scheduled visit; shown to staff. */
  reason: z.string().trim().min(5).max(2000),
  startedAt: isoDateTimeSchema.optional(),
  offlineClientId: z.string().trim().min(8).max(128).optional(),
});
export type SiteVisitUnscheduledStart = z.infer<typeof siteVisitUnscheduledStartSchema>;

export const siteVisitRejectSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
});
export type SiteVisitReject = z.infer<typeof siteVisitRejectSchema>;

/* ---------------------------------------------------------------------- */
/* Reviewer directory                                                      */
/* ---------------------------------------------------------------------- */

export const reviewersQuerySchema = z.object({
  /** Marks the project manager so the picker can suggest them first. */
  projectId: uuidSchema.optional(),
});
export type ReviewersQuery = z.infer<typeof reviewersQuerySchema>;

export const reviewerDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The staff role that carries `reports.review`. */
  role: z.string(),
  isProjectManager: z.boolean(),
});
export type ReviewerDto = z.infer<typeof reviewerDtoSchema>;

export const reviewersResponseSchema = z.object({ items: z.array(reviewerDtoSchema) });

/* ---------------------------------------------------------------------- */
/* Partner-initiated conversations                                         */
/* ---------------------------------------------------------------------- */

export const partnerConversationEntityTypeSchema = z.enum([
  'project',
  'service_request',
  'tender',
  'purchase_order',
  'rfq',
]);
export type PartnerConversationEntityType = z.infer<typeof partnerConversationEntityTypeSchema>;

export const partnerConversationCreateSchema = z.object({
  entityType: partnerConversationEntityTypeSchema,
  entityId: uuidSchema,
  subject: z.string().trim().min(2).max(200),
  message: z.string().trim().min(1).max(20_000),
});
export type PartnerConversationCreate = z.infer<typeof partnerConversationCreateSchema>;

export const partnerConversationResponseSchema = conversationDetailSchema.extend({
  /** Staff added as the SimplexD side of the thread (assigned PM/ops). */
  staffParticipantUserIds: z.array(userIdSchema),
});

/* ---------------------------------------------------------------------- */
/* Partner invoices (payables through the two-approver payout flow)        */
/* ---------------------------------------------------------------------- */

export const partnerInvoiceSourceTypeSchema = z.enum(['purchase_order', 'assignment']);
export type PartnerInvoiceSourceType = z.infer<typeof partnerInvoiceSourceTypeSchema>;

export const partnerInvoiceSubmitSchema = z.object({
  source: z.object({ type: partnerInvoiceSourceTypeSchema, id: uuidSchema }),
  amountKobo: koboStringSchema.refine((v) => /^\d+$/.test(v) && BigInt(v) > 0n, 'positive kobo'),
  currency: z.string().length(3).default('NGN'),
  /** The partner's own invoice number; unique per partner. */
  reference: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional(),
  /** The invoice document, uploaded by the partner (`partner_submission` purpose). */
  attachmentFileId: uuidSchema,
});
export type PartnerInvoiceSubmit = z.infer<typeof partnerInvoiceSubmitSchema>;

export const partnerInvoiceAcceptSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});
export const partnerInvoiceRejectSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
});
/** A reason is required only when re-approving after a failed transfer. */
export const partnerInvoiceSecondApproveSchema = z.object({
  reason: z.string().trim().min(3).max(2000).optional(),
});
export const partnerInvoiceSettleSchema = z.object({
  settlementReference: z.string().trim().min(2).max(120),
});
export const partnerInvoiceFailSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
});

export const partnerInvoiceStatusSchema = payoutStatusSchema;
export type PartnerInvoiceStatus = z.infer<typeof partnerInvoiceStatusSchema>;

export const partnerInvoiceHistoryEntrySchema = z.object({
  at: isoDateTimeSchema,
  action: z.string(),
  byUserId: z.string().nullable(),
  byName: z.string().nullable(),
  note: z.string().nullable(),
});

export const partnerInvoiceDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  organizationName: z.string().nullable(),
  partnerUserId: z.string(),
  partnerName: z.string().nullable(),
  source: z.object({
    type: partnerInvoiceSourceTypeSchema,
    id: uuidSchema,
    label: z.string(),
  }),
  reference: z.string(),
  description: z.string().nullable(),
  attachmentFileId: uuidSchema.nullable(),
  amountKobo: z.string(),
  currency: z.string(),
  status: partnerInvoiceStatusSchema,
  submittedAt: isoDateTimeSchema,
  review: z
    .object({
      decision: z.enum(['accepted', 'rejected']),
      reason: z.string().nullable(),
      byUserId: z.string().nullable(),
      byName: z.string().nullable(),
      at: isoDateTimeSchema,
    })
    .nullable(),
  firstApproverId: z.string().nullable(),
  firstApprovedAt: isoDateTimeSchema.nullable(),
  secondApproverId: z.string().nullable(),
  secondApprovedAt: isoDateTimeSchema.nullable(),
  paymentSubmittedAt: isoDateTimeSchema.nullable(),
  settledAt: isoDateTimeSchema.nullable(),
  failureReason: z.string().nullable(),
  journalId: uuidSchema.nullable(),
  history: z.array(partnerInvoiceHistoryEntrySchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type PartnerInvoiceDto = z.infer<typeof partnerInvoiceDtoSchema>;

export const partnerInvoiceListQuerySchema = cursorPaginationQuerySchema.extend({
  status: partnerInvoiceStatusSchema.optional(),
  /** Staff only. */
  partnerUserId: userIdSchema.optional(),
  organizationId: z.string().min(1).max(64).optional(),
});
export type PartnerInvoiceListQuery = z.infer<typeof partnerInvoiceListQuerySchema>;
