import { z } from 'zod';
import { userIdSchema } from './collaboration';
import {
  cursorPaginationQuerySchema,
  decimalStringSchema,
  evidenceBadgeSchema,
  expectedVersionSchema,
  isoDateTimeSchema,
  timeZoneSchema,
  uuidSchema,
} from './common';
import { lonLatSchema, supplierQuoteDtoSchema } from './markets';

/**
 * Commercial contracts: contractor tendering (sealed bids) and materials
 * procurement (RFQs, delivered-cost comparison, purchase orders, deliveries,
 * discrepancies). Money is integer kobo as decimal strings; timestamps are
 * UTC ISO 8601 and a tender's display time zone is rendered separately.
 */

/* ---------------------------------------------------------------------- */
/* Shared primitives                                                       */
/* ---------------------------------------------------------------------- */

/** Non-negative integer kobo as a string. */
export const commercialKoboSchema = z.string().regex(/^\d+$/, 'integer kobo as a string');
export const commercialCurrencySchema = z.string().length(3).default('NGN');
export const organizationIdSchema = z.string().min(1).max(64);
const reasonSchema = z.string().trim().min(3).max(2000);
const shortText = (max: number) => z.string().trim().max(max);
const jsonRecordSchema = z.record(z.string().max(128), z.unknown());

/** Quantities travel as decimal strings with at most three decimals. */
export const quantitySchema = decimalStringSchema.refine(
  (v) => /^\d+(\.\d{1,3})?$/.test(v) && Number(v) > 0,
  'positive quantity with at most three decimals',
);
export const receivedQuantitySchema = decimalStringSchema.refine(
  (v) => /^\d+(\.\d{1,3})?$/.test(v),
  'non-negative quantity with at most three decimals',
);

/* ---------------------------------------------------------------------- */
/* Tender enums                                                            */
/* ---------------------------------------------------------------------- */

export const tenderStatusSchema = z.enum([
  'draft',
  'published',
  'clarifications',
  'closed',
  'evaluating',
  'awarded',
  'cancelled',
]);
export type TenderStatus = z.infer<typeof tenderStatusSchema>;

export const tenderInvitationStatusSchema = z.enum(['invited', 'viewed', 'declined', 'submitted']);
export type TenderInvitationStatus = z.infer<typeof tenderInvitationStatusSchema>;

export const bidStatusSchema = z.enum([
  'draft',
  'submitted',
  'withdrawn',
  'disqualified',
  'evaluated',
  'awarded',
  'unsuccessful',
]);
export type BidStatus = z.infer<typeof bidStatusSchema>;

export const awardStatusSchema = z.enum([
  'decided',
  'published',
  'accepted',
  'declined',
  'rescinded',
]);
export type AwardStatus = z.infer<typeof awardStatusSchema>;

/* ---------------------------------------------------------------------- */
/* Tender timeline                                                         */
/* ---------------------------------------------------------------------- */

export const tenderTimelineInputSchema = z.object({
  releaseAt: isoDateTimeSchema,
  siteVisitAt: isoDateTimeSchema.nullable().optional(),
  questionCutoffAt: isoDateTimeSchema.nullable().optional(),
  answersPublishedAt: isoDateTimeSchema.nullable().optional(),
  submissionDeadlineAt: isoDateTimeSchema,
  evaluationCompleteAt: isoDateTimeSchema.nullable().optional(),
  awardTargetAt: isoDateTimeSchema.nullable().optional(),
});
export type TenderTimelineInput = z.infer<typeof tenderTimelineInputSchema>;

const timelineValuesSchema = z.object({
  releaseAt: z.string().nullable(),
  siteVisitAt: z.string().nullable(),
  questionCutoffAt: z.string().nullable(),
  answersPublishedAt: z.string().nullable(),
  submissionDeadlineAt: z.string().nullable(),
  evaluationCompleteAt: z.string().nullable(),
  awardTargetAt: z.string().nullable(),
});

export const tenderTimelineViewSchema = z.object({
  utc: timelineValuesSchema,
  display: timelineValuesSchema.extend({ timeZone: z.string() }),
  effectiveSubmissionDeadlineAt: isoDateTimeSchema.nullable(),
  originalSubmissionDeadlineAt: isoDateTimeSchema.nullable(),
  extensionRevision: z.number().int().nullable(),
  biddingWindowDays: z.number().nullable(),
});
export type TenderTimelineViewDto = z.infer<typeof tenderTimelineViewSchema>;

/* ---------------------------------------------------------------------- */
/* Tender inputs                                                           */
/* ---------------------------------------------------------------------- */

export const evaluationWeightsSchema = z
  .record(z.string().trim().min(1).max(64), z.number().positive())
  .refine((w) => Object.keys(w).length > 0, 'at least one named criterion is required')
  .refine((w) => {
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    return Math.abs(sum - 100) <= 1e-6 || Math.abs(sum - 1) <= 1e-9;
  }, 'weights must sum to 100 (percent) or 1.0 (fractions)');

export const tenderCreateSchema = z.object({
  organizationId: organizationIdSchema,
  projectId: uuidSchema.nullable().optional(),
  serviceRequestId: uuidSchema.nullable().optional(),
  title: z.string().trim().min(3).max(200),
  descriptionMarkdown: shortText(20_000).nullable().optional(),
  /** file_objects ids owned by the tender's organisation. */
  scopeFileIds: z.array(uuidSchema).max(50).default([]),
  boqBudgetVersionId: uuidSchema.nullable().optional(),
  timeline: tenderTimelineInputSchema,
  displayTimeZone: timeZoneSchema.default('Africa/Lagos'),
  evaluationWeights: evaluationWeightsSchema,
  /** Disclosed relationships between SimplexD and invited partners; shown to every invitee. */
  partnerDisclosure: shortText(4000).nullable().optional(),
  sealed: z.boolean().default(true),
});
export type TenderCreate = z.infer<typeof tenderCreateSchema>;

/** Draft-only edits; after publication use a revision. */
export const tenderDraftPatchSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  descriptionMarkdown: shortText(20_000).nullable().optional(),
  scopeFileIds: z.array(uuidSchema).max(50).optional(),
  boqBudgetVersionId: uuidSchema.nullable().optional(),
  projectId: uuidSchema.nullable().optional(),
  timeline: tenderTimelineInputSchema.optional(),
  displayTimeZone: timeZoneSchema.optional(),
  evaluationWeights: evaluationWeightsSchema.optional(),
  partnerDisclosure: shortText(4000).nullable().optional(),
  sealed: z.boolean().optional(),
  expectedVersion: expectedVersionSchema,
});
export type TenderDraftPatch = z.infer<typeof tenderDraftPatchSchema>;

export const tenderRevisionChangesSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  descriptionMarkdown: shortText(20_000).nullable().optional(),
  scopeFileIds: z.array(uuidSchema).max(50).optional(),
  siteVisitAt: isoDateTimeSchema.nullable().optional(),
  questionCutoffAt: isoDateTimeSchema.nullable().optional(),
  answersPublishedAt: isoDateTimeSchema.nullable().optional(),
  evaluationCompleteAt: isoDateTimeSchema.nullable().optional(),
  awardTargetAt: isoDateTimeSchema.nullable().optional(),
  partnerDisclosure: shortText(4000).nullable().optional(),
});
export type TenderRevisionChanges = z.infer<typeof tenderRevisionChangesSchema>;

/** A change to a published tender: append-only revision with an optional addendum and deadline extension. */
export const tenderRevisionCreateSchema = z
  .object({
    changes: tenderRevisionChangesSchema.default({}),
    addendumMarkdown: shortText(20_000).nullable().optional(),
    /** Deadlines can only move later; never earlier. */
    deadlineExtendedTo: isoDateTimeSchema.nullable().optional(),
    reason: reasonSchema,
    expectedVersion: expectedVersionSchema,
  })
  .refine(
    (v) =>
      Object.keys(v.changes).length > 0 ||
      Boolean(v.addendumMarkdown) ||
      Boolean(v.deadlineExtendedTo),
    'a revision needs changes, an addendum or a deadline extension',
  );
export type TenderRevisionCreate = z.infer<typeof tenderRevisionCreateSchema>;

export const tenderVariationSchema = z.object({
  reason: reasonSchema,
  changes: jsonRecordSchema.default({}),
  addendumMarkdown: shortText(20_000).nullable().optional(),
});
export type TenderVariation = z.infer<typeof tenderVariationSchema>;

export const tenderPublishSchema = z.object({ expectedVersion: expectedVersionSchema });
export const tenderCloseSchema = z.object({ expectedVersion: expectedVersionSchema.optional() });
export const tenderCancelSchema = z.object({
  reason: reasonSchema,
  expectedVersion: expectedVersionSchema,
});

export const tenderInviteSchema = z.object({
  partnerUserIds: z.array(userIdSchema).min(1).max(50),
});
export type TenderInvite = z.infer<typeof tenderInviteSchema>;

export const tenderInvitationRespondSchema = z.object({
  decision: z.enum(['accept', 'decline']),
  note: shortText(2000).nullable().optional(),
});
export type TenderInvitationRespond = z.infer<typeof tenderInvitationRespondSchema>;

export const tenderQuestionAskSchema = z.object({
  question: z.string().trim().min(5).max(4000),
});
export const tenderQuestionAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(8000),
  /** Publishing makes the anonymised question and answer visible to every invitee. */
  publish: z.boolean().default(false),
});

export const tenderListQuerySchema = cursorPaginationQuerySchema.extend({
  status: tenderStatusSchema.optional(),
  organizationId: organizationIdSchema.optional(),
  projectId: uuidSchema.optional(),
});
export type TenderListQuery = z.infer<typeof tenderListQuerySchema>;

export const partnerTenderListQuerySchema = cursorPaginationQuerySchema.extend({
  status: tenderStatusSchema.optional(),
});
export const partnerBidListQuerySchema = cursorPaginationQuerySchema.extend({
  status: bidStatusSchema.optional(),
});
export const partnerAwardListQuerySchema = cursorPaginationQuerySchema;

/* ---------------------------------------------------------------------- */
/* Tender DTOs                                                             */
/* ---------------------------------------------------------------------- */

export const tenderDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  projectId: uuidSchema.nullable(),
  serviceRequestId: uuidSchema.nullable(),
  reference: z.string(),
  title: z.string(),
  descriptionMarkdown: z.string().nullable(),
  scopeFileIds: z.array(uuidSchema),
  boqBudgetVersionId: uuidSchema.nullable(),
  status: tenderStatusSchema,
  sealed: z.boolean(),
  timeline: tenderTimelineViewSchema,
  displayTimeZone: z.string(),
  currentRevision: z.number().int(),
  evaluationWeights: z.record(z.string(), z.number()),
  partnerDisclosure: z.string().nullable(),
  closedAt: isoDateTimeSchema.nullable(),
  cancelledReason: z.string().nullable(),
  createdBy: z.string().nullable(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type TenderDto = z.infer<typeof tenderDtoSchema>;

export const tenderRevisionDtoSchema = z.object({
  id: uuidSchema,
  tenderId: uuidSchema,
  revision: z.number().int(),
  changes: jsonRecordSchema,
  addendumMarkdown: z.string().nullable(),
  deadlineExtendedTo: isoDateTimeSchema.nullable(),
  reason: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type TenderRevisionDto = z.infer<typeof tenderRevisionDtoSchema>;

export const tenderInvitationDtoSchema = z.object({
  id: uuidSchema,
  tenderId: uuidSchema,
  partnerUserId: z.string(),
  partnerName: z.string().nullable(),
  status: tenderInvitationStatusSchema,
  invitedBy: z.string().nullable(),
  invitedAt: isoDateTimeSchema,
  viewedAt: isoDateTimeSchema.nullable(),
  respondedAt: isoDateTimeSchema.nullable(),
});
export type TenderInvitationDto = z.infer<typeof tenderInvitationDtoSchema>;

export const tenderQuestionDtoSchema = z.object({
  id: uuidSchema,
  tenderId: uuidSchema,
  question: z.string(),
  askedAt: isoDateTimeSchema,
  /** Only staff learn who asked; everyone else sees `askedByMe`. */
  askedByUserId: z.string().nullable(),
  askedByMe: z.boolean(),
  answer: z.string().nullable(),
  answeredAt: isoDateTimeSchema.nullable(),
  published: z.boolean(),
});
export type TenderQuestionDto = z.infer<typeof tenderQuestionDtoSchema>;

export const bidLineItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: decimalStringSchema.nullable().optional(),
  unit: z.string().trim().max(32).nullable().optional(),
  rateKobo: commercialKoboSchema.nullable().optional(),
  amountKobo: commercialKoboSchema,
});

export const bidRevisionInputSchema = z.object({
  amountKobo: commercialKoboSchema,
  currency: commercialCurrencySchema,
  lineItems: z.array(bidLineItemSchema).max(500).default([]),
  durationDays: z.number().int().positive().max(3650).nullable().optional(),
  qualifications: jsonRecordSchema.default({}),
  /** file_objects owned by the submitting partner. */
  attachmentFileIds: z.array(uuidSchema).max(30).default([]),
});
export type BidRevisionInput = z.infer<typeof bidRevisionInputSchema>;

export const bidSubmitSchema = z.object({
  /** Content to submit; when omitted the latest unsubmitted revision is submitted. */
  revision: bidRevisionInputSchema.optional(),
  /** Logged only; never influences the deadline decision. */
  clientClaimedTime: isoDateTimeSchema.nullable().optional(),
  expectedVersion: expectedVersionSchema.optional(),
});
export type BidSubmit = z.infer<typeof bidSubmitSchema>;

export const bidWithdrawSchema = z.object({
  reason: reasonSchema,
  expectedVersion: expectedVersionSchema.optional(),
});

export const bidRevisionDtoSchema = z.object({
  version: z.number().int(),
  amountKobo: z.string(),
  currency: z.string(),
  lineItems: z.array(bidLineItemSchema),
  durationDays: z.number().int().nullable(),
  qualifications: jsonRecordSchema,
  attachmentFileIds: z.array(uuidSchema),
  submittedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type BidRevisionDto = z.infer<typeof bidRevisionDtoSchema>;

/** What a party other than the bidder sees while the bid is sealed: existence, partner and submission time only. */
export const bidSummaryDtoSchema = z.object({
  id: uuidSchema.nullable(),
  tenderId: uuidSchema,
  partnerUserId: z.string(),
  partnerName: z.string().nullable(),
  status: bidStatusSchema,
  currentVersion: z.number().int().nullable(),
  submittedAt: isoDateTimeSchema.nullable(),
  withdrawnAt: isoDateTimeSchema.nullable(),
  sealed: z.boolean(),
  openedAt: isoDateTimeSchema.nullable(),
  version: z.number().int().nullable(),
});
export type BidSummaryDto = z.infer<typeof bidSummaryDtoSchema>;

export const bidDtoSchema = bidSummaryDtoSchema.extend({
  id: uuidSchema,
  sealed: z.literal(false),
  currentVersion: z.number().int(),
  version: z.number().int(),
  openedBy: z.string().nullable(),
  openReason: z.string().nullable(),
  revisions: z.array(bidRevisionDtoSchema),
  latestRevision: bidRevisionDtoSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type BidDto = z.infer<typeof bidDtoSchema>;

export const bidReadDtoSchema = z.union([bidDtoSchema, bidSummaryDtoSchema]);
export type BidReadDto = z.infer<typeof bidReadDtoSchema>;

export const tenderDetailSchema = tenderDtoSchema.extend({
  revisions: z.array(tenderRevisionDtoSchema),
  /** Staff and customers: every invitation; partners: only their own. */
  invitations: z.array(tenderInvitationDtoSchema),
  questions: z.array(tenderQuestionDtoSchema),
  myInvitation: tenderInvitationDtoSchema.nullable(),
  myBid: bidSummaryDtoSchema.nullable(),
  bidCount: z.number().int().nullable(),
});
export type TenderDetail = z.infer<typeof tenderDetailSchema>;

export const invitedTenderDtoSchema = tenderDtoSchema.extend({
  invitation: tenderInvitationDtoSchema,
  myBid: bidSummaryDtoSchema.nullable(),
});
export type InvitedTenderDto = z.infer<typeof invitedTenderDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Sealing, evaluation and award                                           */
/* ---------------------------------------------------------------------- */

export const bidsOpenSchema = z.object({ reason: z.string().trim().min(5).max(2000) });
export const tenderEvaluateStartSchema = z.object({
  /** Reason recorded when opening the sealed bids as part of starting evaluation. */
  reason: z.string().trim().min(5).max(2000),
  expectedVersion: expectedVersionSchema.optional(),
});

export const bidEvaluationInputSchema = z.object({
  /** One 0-100 score per named criterion of the tender's evaluation weights. */
  scores: z.record(z.string().min(1).max(64), z.number().min(0).max(100)),
  notes: shortText(4000).nullable().optional(),
});
export type BidEvaluationInput = z.infer<typeof bidEvaluationInputSchema>;

export const bidDisqualifySchema = z.object({ reason: reasonSchema });

export const bidEvaluationDtoSchema = z.object({
  id: uuidSchema,
  tenderId: uuidSchema,
  bidId: uuidSchema,
  evaluatorUserId: z.string(),
  evaluatorName: z.string().nullable(),
  scores: z.record(z.string(), z.number()),
  weightedScore: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type BidEvaluationDto = z.infer<typeof bidEvaluationDtoSchema>;

export const tenderComparisonBidSchema = z.object({
  bidId: uuidSchema,
  partnerUserId: z.string(),
  partnerName: z.string().nullable(),
  status: bidStatusSchema,
  revisionVersion: z.number().int().nullable(),
  amountKobo: z.string().nullable(),
  currency: z.string().nullable(),
  durationDays: z.number().int().nullable(),
  submittedAt: isoDateTimeSchema.nullable(),
  evaluations: z.array(bidEvaluationDtoSchema),
  averageWeightedScore: z.string().nullable(),
  evaluatorCount: z.number().int(),
  rank: z.number().int().nullable(),
});

export const tenderComparisonDtoSchema = z.object({
  tenderId: uuidSchema,
  reference: z.string(),
  status: tenderStatusSchema,
  evaluationWeights: z.record(z.string(), z.number()),
  criteria: z.array(z.string()),
  bids: z.array(tenderComparisonBidSchema),
});
export type TenderComparisonDto = z.infer<typeof tenderComparisonDtoSchema>;

export const awardDecideSchema = z.object({
  bidId: uuidSchema,
  notes: shortText(4000).nullable().optional(),
  expectedVersion: expectedVersionSchema,
});
export const awardPublishSchema = z.object({ expectedVersion: expectedVersionSchema });
export const awardRespondSchema = z.object({
  decision: z.enum(['accept', 'decline']),
  note: shortText(2000).nullable().optional(),
});

export const awardDtoSchema = z.object({
  id: uuidSchema,
  tenderId: uuidSchema,
  tenderReference: z.string(),
  tenderTitle: z.string(),
  bidId: uuidSchema,
  partnerUserId: z.string(),
  partnerName: z.string().nullable(),
  status: awardStatusSchema,
  contractValueKobo: z.string().nullable(),
  currency: z.string(),
  decidedBy: z.string().nullable(),
  decidedAt: isoDateTimeSchema,
  publishedAt: isoDateTimeSchema.nullable(),
  publishedBy: z.string().nullable(),
  notes: z.string().nullable(),
  respondedAt: isoDateTimeSchema.nullable(),
});
export type AwardDto = z.infer<typeof awardDtoSchema>;

/** A partner's view of a published award: winners see the award, others only that they were unsuccessful. */
export const awardOutcomeDtoSchema = z.object({
  tenderId: uuidSchema,
  tenderReference: z.string(),
  tenderTitle: z.string(),
  outcome: z.enum(['awarded', 'unsuccessful']),
  publishedAt: isoDateTimeSchema,
  bidStatus: bidStatusSchema,
  award: awardDtoSchema.nullable(),
});
export type AwardOutcomeDto = z.infer<typeof awardOutcomeDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Procurement enums                                                       */
/* ---------------------------------------------------------------------- */

export const procurementMaterialSchema = z.enum([
  'cement',
  'ready_mix',
  'steel',
  'sand',
  'aggregate',
  'blocks',
  'timber',
  'roofing',
  'electrical',
  'plumbing',
  'other',
]);
export type ProcurementMaterial = z.infer<typeof procurementMaterialSchema>;

export const rfqStatusSchema = z.enum(['draft', 'sent', 'closed', 'awarded', 'cancelled']);
export const rfqResponseStatusSchema = z.enum([
  'draft',
  'submitted',
  'withdrawn',
  'selected',
  'rejected',
]);
export const purchaseOrderStatusSchema = z.enum([
  'draft',
  'issued',
  'acknowledged',
  'partially_delivered',
  'delivered',
  'closed',
  'cancelled',
]);
export const deliveryStatusSchema = z.enum(['pending', 'received', 'disputed', 'accepted']);
export const discrepancyStatusSchema = z.enum([
  'open',
  'supplier_notified',
  'resolved',
  'credited',
  'returned',
]);
export const discrepancyKindSchema = z.enum(['short_delivery', 'damaged', 'wrong_spec', 'other']);
export const conversionBasisSchema = z.enum(['supplier_declared', 'staff_measured']);

export const declaredConversionSchema = z.object({
  fromUnit: z.string().trim().min(1).max(32),
  toUnit: z.string().trim().min(1).max(32),
  /** 1 fromUnit = factor toUnit. */
  factor: decimalStringSchema.refine(
    (v) => /^\d+(\.\d{1,6})?$/.test(v) && Number(v) > 0,
    'positive factor, at most six decimals',
  ),
  basis: conversionBasisSchema,
});
export type DeclaredConversionDto = z.infer<typeof declaredConversionSchema>;

/* ---------------------------------------------------------------------- */
/* Supplier directory                                                      */
/* ---------------------------------------------------------------------- */

export const supplierDirectoryQuerySchema = z.object({
  marketId: uuidSchema.optional(),
  material: procurementMaterialSchema.optional(),
  stateId: uuidSchema.optional(),
  includeArchived: z.enum(['true', 'false']).default('false'),
});
export type SupplierDirectoryQuery = z.infer<typeof supplierDirectoryQuerySchema>;

export const supplierDirectoryEntrySchema = z.object({
  facilityId: uuidSchema,
  slug: z.string(),
  name: z.string(),
  operator: z.string().nullable(),
  material: z.string(),
  stateId: uuidSchema.nullable(),
  stateName: z.string().nullable(),
  evidenceStatus: z.enum(['published_facility_location', 'unverified_lead', 'verified_supplier']),
  evidenceLabel: z.string(),
  deliveryCoverageVerified: z.boolean(),
  stockStatus: z.string(),
  rankEligible: z.boolean(),
  contactPermission: z.boolean(),
  notes: z.string().nullable(),
  location: lonLatSchema.nullable(),
  archivedAt: isoDateTimeSchema.nullable(),
  coverage: z.array(
    z.object({
      marketId: uuidSchema,
      marketName: z.string().nullable(),
      relation: z.string(),
      relationLabel: z.string(),
      verifiedAt: isoDateTimeSchema.nullable(),
      note: z.string().nullable(),
      badge: evidenceBadgeSchema,
    }),
  ),
  quotes: z.array(supplierQuoteDtoSchema),
  priceEvidence: z.enum([
    'no_quote_on_file',
    'quote_pending_review',
    'verified_quote',
    'stale_quote',
    'disputed_quote',
  ]),
});
export type SupplierDirectoryEntry = z.infer<typeof supplierDirectoryEntrySchema>;

export const supplierDirectoryResponseSchema = z.object({
  items: z.array(supplierDirectoryEntrySchema),
  note: z.string(),
});

/* ---------------------------------------------------------------------- */
/* RFQs                                                                    */
/* ---------------------------------------------------------------------- */

export const rfqItemInputSchema = z.object({
  material: procurementMaterialSchema,
  specification: z.string().trim().min(1).max(500),
  unit: z.string().trim().min(1).max(32),
  quantity: quantitySchema,
  sortOrder: z.number().int().min(0).optional(),
});
export type RfqItemInput = z.infer<typeof rfqItemInputSchema>;

export const rfqCreateSchema = z.object({
  organizationId: organizationIdSchema,
  projectId: uuidSchema.nullable().optional(),
  title: z.string().trim().min(3).max(200),
  deliveryMarketId: uuidSchema.nullable().optional(),
  deliveryAddress: z.record(z.string().max(64), z.string().max(500)).nullable().optional(),
  notes: shortText(8000).nullable().optional(),
  items: z.array(rfqItemInputSchema).max(200).default([]),
});
export type RfqCreate = z.infer<typeof rfqCreateSchema>;

export const rfqPatchSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  projectId: uuidSchema.nullable().optional(),
  deliveryMarketId: uuidSchema.nullable().optional(),
  deliveryAddress: z.record(z.string().max(64), z.string().max(500)).nullable().optional(),
  notes: shortText(8000).nullable().optional(),
});
export const rfqItemsReplaceSchema = z.object({
  items: z.array(rfqItemInputSchema).min(1).max(200),
});

export const rfqIssueSchema = z.object({
  deadlineAt: isoDateTimeSchema,
  supplierUserIds: z.array(userIdSchema).max(50).default([]),
});
export const rfqInviteSchema = z.object({ supplierUserIds: z.array(userIdSchema).min(1).max(50) });
export const rfqCancelSchema = z.object({ reason: reasonSchema });

export const rfqResponseLineInputSchema = z.object({
  itemId: uuidSchema,
  /** Price per `quantityUnit`. */
  unitPriceKobo: commercialKoboSchema,
  quantityUnit: z.string().trim().min(1).max(32),
  /** Required for comparison whenever quantityUnit differs from the RFQ item's unit. */
  declaredConversion: declaredConversionSchema.nullable().optional(),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
  note: shortText(1000).nullable().optional(),
});
export type RfqResponseLineInput = z.infer<typeof rfqResponseLineInputSchema>;

export const rfqResponseSubmitSchema = z.object({
  /** Staff only: record a response on behalf of an invited supplier user. */
  supplierUserId: userIdSchema.optional(),
  /** Staff only: manual response from a supplier without an account. */
  supplierName: z.string().trim().min(2).max(200).optional(),
  supplierFacilityId: uuidSchema.nullable().optional(),
  currency: commercialCurrencySchema,
  lines: z.array(rfqResponseLineInputSchema).min(1).max(200),
  deliveryKobo: commercialKoboSchema,
  leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
  validUntil: isoDateTimeSchema.nullable().optional(),
  submit: z.boolean().default(true),
});
export type RfqResponseSubmit = z.infer<typeof rfqResponseSubmitSchema>;

export const rfqItemDtoSchema = z.object({
  id: uuidSchema,
  rfqId: uuidSchema,
  material: procurementMaterialSchema,
  specification: z.string(),
  unit: z.string(),
  quantity: z.string(),
  sortOrder: z.number().int(),
});
export type RfqItemDto = z.infer<typeof rfqItemDtoSchema>;

export const rfqResponseLineDtoSchema = z.object({
  itemId: uuidSchema,
  unitPriceKobo: z.string(),
  quantityUnit: z.string(),
  declaredConversion: declaredConversionSchema.nullable(),
  leadTimeDays: z.number().int().nullable(),
  note: z.string().nullable(),
});

export const rfqResponseDtoSchema = z.object({
  id: uuidSchema,
  rfqId: uuidSchema,
  supplierUserId: z.string().nullable(),
  supplierName: z.string().nullable(),
  supplierFacilityId: uuidSchema.nullable(),
  status: rfqResponseStatusSchema,
  currency: z.string(),
  lines: z.array(rfqResponseLineDtoSchema),
  deliveryKobo: z.string().nullable(),
  leadTimeDays: z.number().int().nullable(),
  /** Goods + delivery when every line is comparable in the RFQ units; otherwise null. */
  totalDeliveredKobo: z.string().nullable(),
  validUntil: isoDateTimeSchema.nullable(),
  submittedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type RfqResponseDto = z.infer<typeof rfqResponseDtoSchema>;

export const rfqDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  projectId: uuidSchema.nullable(),
  reference: z.string(),
  title: z.string(),
  status: rfqStatusSchema,
  deadlineAt: isoDateTimeSchema.nullable(),
  deliveryMarketId: uuidSchema.nullable(),
  deliveryMarketName: z.string().nullable(),
  deliveryAddress: z.record(z.string(), z.string()).nullable(),
  notes: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type RfqDto = z.infer<typeof rfqDtoSchema>;

export const rfqDetailSchema = rfqDtoSchema.extend({
  items: z.array(rfqItemDtoSchema),
  /** Staff and customers: every response; suppliers: only their own. */
  responses: z.array(rfqResponseDtoSchema),
});
export type RfqDetail = z.infer<typeof rfqDetailSchema>;

export const rfqListQuerySchema = cursorPaginationQuerySchema.extend({
  status: rfqStatusSchema.optional(),
  organizationId: organizationIdSchema.optional(),
  projectId: uuidSchema.optional(),
});
export type RfqListQuery = z.infer<typeof rfqListQuerySchema>;

const comparisonLineSchema = z.object({
  itemId: z.string(),
  comparable: z.boolean(),
  reason: z.string().nullable(),
  message: z.string().nullable(),
  rfqUnit: z.string(),
  rfqQuantity: z.string(),
  supplierUnit: z.string().nullable(),
  supplierUnitPriceKobo: z.string().nullable(),
  supplierUnitsRequired: z.string().nullable(),
  normalizedUnitPriceKobo: z.string().nullable(),
  lineTotalKobo: z.string().nullable(),
  conversion: z
    .object({ fromUnit: z.string(), toUnit: z.string(), factor: z.string(), basis: z.string() })
    .nullable(),
  partialSupplierUnit: z.boolean(),
  leadTimeDays: z.number().int().nullable(),
  note: z.string().nullable(),
});

export const rfqComparisonDtoSchema = z.object({
  rfqId: uuidSchema,
  currency: z.string(),
  items: z.array(rfqItemDtoSchema),
  entries: z.array(
    z.object({
      responseId: z.string(),
      supplierLabel: z.string(),
      currency: z.string(),
      lines: z.array(comparisonLineSchema),
      comparableLines: z.number().int(),
      totalLines: z.number().int(),
      fullyComparable: z.boolean(),
      comparableGoodsKobo: z.string(),
      goodsKobo: z.string().nullable(),
      deliveryKobo: z.string().nullable(),
      totalDeliveredKobo: z.string().nullable(),
      unknowns: z.array(
        z.object({ itemId: z.string().nullable(), reason: z.string(), message: z.string() }),
      ),
      rank: z.number().int().nullable(),
      leadTimeDays: z.number().int().nullable(),
      validUntil: z.string().nullable(),
    }),
  ),
  ranked: z.array(z.string()),
  note: z.string(),
});
export type RfqComparisonDto = z.infer<typeof rfqComparisonDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Purchase orders                                                         */
/* ---------------------------------------------------------------------- */

export const purchaseOrderCreateSchema = z.object({
  responseId: uuidSchema,
  projectId: uuidSchema.nullable().optional(),
  expectedDeliveryAt: isoDateTimeSchema.nullable().optional(),
  supplierRef: shortText(120).nullable().optional(),
  /** Staff-measured conversions for lines the supplier priced in another unit without declaring a factor. */
  lineConversions: z
    .array(z.object({ itemId: uuidSchema, declaredConversion: declaredConversionSchema }))
    .max(200)
    .default([]),
});
export type PurchaseOrderCreate = z.infer<typeof purchaseOrderCreateSchema>;

export const purchaseOrderIssueSchema = z.object({
  expectedVersion: expectedVersionSchema.optional(),
});
export const purchaseOrderAcknowledgeSchema = z.object({
  supplierRef: shortText(120).nullable().optional(),
  expectedDeliveryAt: isoDateTimeSchema.nullable().optional(),
  expectedVersion: expectedVersionSchema.optional(),
});
export const purchaseOrderCancelSchema = z.object({
  reason: reasonSchema,
  expectedVersion: expectedVersionSchema,
});

export const purchaseOrderLineDtoSchema = z.object({
  lineId: z.string(),
  itemId: uuidSchema.nullable(),
  material: z.string(),
  specification: z.string(),
  /** Buyer's unit and quantity (the RFQ item). */
  unit: z.string(),
  quantity: z.string(),
  /** Supplier's pricing unit and price per that unit. */
  supplierUnit: z.string(),
  unitPriceKobo: z.string(),
  conversion: declaredConversionSchema.nullable(),
  lineTotalKobo: z.string(),
});
export type PurchaseOrderLineDto = z.infer<typeof purchaseOrderLineDtoSchema>;

export const lineVarianceDtoSchema = z.object({
  lineId: z.string(),
  ordered: z.string(),
  received: z.string(),
  outstanding: z.string(),
  excess: z.string(),
  status: z.enum(['not_received', 'short', 'complete', 'over']),
  outstandingValueKobo: z.string().nullable(),
});

export const purchaseOrderDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  projectId: uuidSchema.nullable(),
  rfqId: uuidSchema.nullable(),
  responseId: uuidSchema.nullable(),
  number: z.string(),
  status: purchaseOrderStatusSchema,
  supplierUserId: z.string().nullable(),
  supplierName: z.string().nullable(),
  supplierRef: z.string().nullable(),
  lines: z.array(purchaseOrderLineDtoSchema),
  deliveryKobo: z.string(),
  totalKobo: z.string(),
  currency: z.string(),
  issuedAt: isoDateTimeSchema.nullable(),
  expectedDeliveryAt: isoDateTimeSchema.nullable(),
  createdBy: z.string().nullable(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type PurchaseOrderDto = z.infer<typeof purchaseOrderDtoSchema>;

export const purchaseOrderDetailSchema = purchaseOrderDtoSchema.extend({
  deliveryProgress: z.object({
    status: z.enum(['pending', 'partially_delivered', 'delivered']),
    lines: z.array(lineVarianceDtoSchema),
  }),
});
export type PurchaseOrderDetail = z.infer<typeof purchaseOrderDetailSchema>;

export const purchaseOrderListQuerySchema = cursorPaginationQuerySchema.extend({
  status: purchaseOrderStatusSchema.optional(),
  organizationId: organizationIdSchema.optional(),
  rfqId: uuidSchema.optional(),
  projectId: uuidSchema.optional(),
});
export type PurchaseOrderListQuery = z.infer<typeof purchaseOrderListQuerySchema>;

/* ---------------------------------------------------------------------- */
/* Deliveries and discrepancies                                            */
/* ---------------------------------------------------------------------- */

export const deliveryRecordSchema = z.object({
  deliveredAt: isoDateTimeSchema,
  receivedByUserId: userIdSchema.nullable().optional(),
  lines: z
    .array(
      z.object({
        lineId: z.string().min(1).max(64),
        quantityReceived: receivedQuantitySchema,
        note: shortText(1000).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
  evidenceFileIds: z.array(uuidSchema).max(50).default([]),
  note: shortText(4000).nullable().optional(),
});
export type DeliveryRecord = z.infer<typeof deliveryRecordSchema>;

export const discrepancyCreateSchema = z.object({
  lineId: z.string().min(1).max(64).nullable().optional(),
  kind: discrepancyKindSchema,
  description: z.string().trim().min(3).max(4000),
  quantity: receivedQuantitySchema.nullable().optional(),
});
export type DiscrepancyCreate = z.infer<typeof discrepancyCreateSchema>;

export const discrepancyTransitionSchema = z
  .object({
    to: z.enum(['supplier_notified', 'resolved', 'credited', 'returned']),
    resolution: shortText(4000).nullable().optional(),
  })
  .refine(
    (v) => v.to === 'supplier_notified' || Boolean(v.resolution && v.resolution.length > 0),
    'a resolution note is required to resolve, credit or return',
  );
export type DiscrepancyTransition = z.infer<typeof discrepancyTransitionSchema>;

export const discrepancyDtoSchema = z.object({
  id: uuidSchema,
  deliveryId: uuidSchema,
  lineId: z.string().nullable(),
  kind: z.string(),
  description: z.string(),
  quantity: z.string().nullable(),
  status: discrepancyStatusSchema,
  resolution: z.string().nullable(),
  createdBy: z.string().nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type DiscrepancyDto = z.infer<typeof discrepancyDtoSchema>;

export const deliveryDtoSchema = z.object({
  id: uuidSchema,
  purchaseOrderId: uuidSchema,
  purchaseOrderNumber: z.string(),
  deliveredAt: isoDateTimeSchema.nullable(),
  receivedByUserId: z.string().nullable(),
  lines: z.array(
    z.object({
      lineId: z.string(),
      quantityReceived: z.string(),
      note: z.string().nullable(),
      discrepancyIds: z.array(uuidSchema),
    }),
  ),
  evidenceFileIds: z.array(uuidSchema),
  status: deliveryStatusSchema,
  note: z.string().nullable(),
  discrepancies: z.array(discrepancyDtoSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type DeliveryDto = z.infer<typeof deliveryDtoSchema>;

export const deliveryListQuerySchema = cursorPaginationQuerySchema.extend({
  purchaseOrderId: uuidSchema.optional(),
  status: deliveryStatusSchema.optional(),
});
export type DeliveryListQuery = z.infer<typeof deliveryListQuerySchema>;
