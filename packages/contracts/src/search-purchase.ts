import { z } from 'zod';
import { isoDateTimeSchema, uuidSchema } from './common';

/**
 * Property search and purchase representation (build brief §8): saved
 * searches with alerts, the engagement shortlist and its side-by-side
 * comparison, viewings, offers with an append-only negotiation log,
 * conditions, the diligence dependency, the closing checklist and document
 * handover. Money travels as integer kobo strings.
 */

const positiveKobo = z.string().regex(/^[1-9]\d*$/, 'positive integer kobo as a string');
const nonNegativeKobo = z.string().regex(/^\d+$/, 'non-negative integer kobo as a string');
/** Optional free text; an empty or blank string counts as absent. */
const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim().length === 0 ? undefined : v),
    z.string().trim().max(max).optional(),
  );

/** Opaque optimistic-concurrency token: the record's `updatedAt` as the caller loaded it. */
const expectedUpdatedAtSchema = isoDateTimeSchema;

/* ---------------------------------------------------------------------- */
/* Saved searches                                                          */
/* ---------------------------------------------------------------------- */

export const searchListingKindSchema = z.enum(['sale', 'lease', 'short_stay']);
export const searchPropertyKindSchema = z.enum([
  'land',
  'residential',
  'commercial',
  'industrial',
  'mixed_use',
  'student_housing',
  'short_stay',
]);

export const searchCriteriaSchema = z
  .object({
    listingKinds: z.array(searchListingKindSchema).max(3).default([]),
    propertyKinds: z.array(searchPropertyKindSchema).max(7).default([]),
    minPriceKobo: nonNegativeKobo.nullable().optional(),
    maxPriceKobo: nonNegativeKobo.nullable().optional(),
    minAreaM2: z.number().nonnegative().max(100_000_000).nullable().optional(),
    maxAreaM2: z.number().nonnegative().max(100_000_000).nullable().optional(),
    marketIds: z.array(uuidSchema).max(50).default([]),
    stateIds: z.array(uuidSchema).max(37).default([]),
    requireTenureDisclosed: z.boolean().default(false),
    requireTitleDisclosure: z.boolean().default(false),
    requiredVerificationChecks: z.array(z.string().trim().min(2).max(80)).max(10).default([]),
    keywords: z.string().trim().max(120).nullable().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.minPriceKobo && c.maxPriceKobo && BigInt(c.minPriceKobo) > BigInt(c.maxPriceKobo)) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxPriceKobo'],
        message: 'maximum price is below the minimum',
      });
    }
    if (
      c.minAreaM2 !== null &&
      c.minAreaM2 !== undefined &&
      c.maxAreaM2 !== null &&
      c.maxAreaM2 !== undefined &&
      c.minAreaM2 > c.maxAreaM2
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxAreaM2'],
        message: 'maximum area is below the minimum',
      });
    }
  });
export type SearchCriteriaInput = z.infer<typeof searchCriteriaSchema>;

export const savedSearchCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  criteria: searchCriteriaSchema,
  alertsEnabled: z.boolean().default(false),
});
export type SavedSearchCreate = z.infer<typeof savedSearchCreateSchema>;

export const savedSearchUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  criteria: searchCriteriaSchema.optional(),
  alertsEnabled: z.boolean().optional(),
  expectedUpdatedAt: expectedUpdatedAtSchema,
});
export type SavedSearchUpdate = z.infer<typeof savedSearchUpdateSchema>;

export const savedSearchDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  organizationId: z.string().nullable(),
  criteria: searchCriteriaSchema,
  alertsEnabled: z.boolean(),
  /** Alert watermark: listings published after this are checked on the next run. */
  lastRunAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type SavedSearchDto = z.infer<typeof savedSearchDtoSchema>;

/** A published listing as the search and shortlist tools show it (public-safe fields). */
export const searchListingDtoSchema = z.object({
  id: uuidSchema,
  slug: z.string(),
  title: z.string(),
  kind: searchListingKindSchema,
  propertyKind: z.string().nullable(),
  priceKobo: z.string().nullable(),
  priceBasis: z.string().nullable(),
  currency: z.string(),
  areaM2: z.string().nullable(),
  tenure: z.string().nullable(),
  titleDisclosure: z.string().nullable(),
  marketName: z.string().nullable(),
  stateName: z.string().nullable(),
  publicLocationPrecision: z.string().nullable(),
  publishedAt: isoDateTimeSchema.nullable(),
});
export type SearchListingDto = z.infer<typeof searchListingDtoSchema>;

export const savedSearchMatchesDtoSchema = z.object({
  items: z.array(searchListingDtoSchema),
  /** Published listings evaluated. */
  evaluated: z.number().int().nonnegative(),
});
export type SavedSearchMatchesDto = z.infer<typeof savedSearchMatchesDtoSchema>;

export const searchListingQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/* ---------------------------------------------------------------------- */
/* Shortlists                                                              */
/* ---------------------------------------------------------------------- */

export const shortlistStatusSchema = z.enum(['draft', 'shared', 'accepted', 'outcome_recorded']);
export type ShortlistStatusDto = z.infer<typeof shortlistStatusSchema>;

export const shortlistItemStatusSchema = z.enum([
  'candidate',
  'preferred',
  'viewing_requested',
  'viewed',
  'rejected',
  'removed',
]);
export type ShortlistItemStatusDto = z.infer<typeof shortlistItemStatusSchema>;

export const searchOutcomeSchema = z.enum([
  'property_selected',
  'proceeding_to_purchase',
  'no_suitable_property',
  'customer_paused_search',
  'purchased_elsewhere',
]);
export type SearchOutcomeDto = z.infer<typeof searchOutcomeSchema>;

export const shortlistCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
});
export type ShortlistCreate = z.infer<typeof shortlistCreateSchema>;

export const shortlistUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  /** Staff share a draft with the customer or take it back to draft. */
  status: z.enum(['draft', 'shared']).optional(),
  expectedUpdatedAt: expectedUpdatedAtSchema,
});
export type ShortlistUpdate = z.infer<typeof shortlistUpdateSchema>;

export const shortlistItemAddSchema = z.union([
  z.object({
    listingId: uuidSchema,
    notes: optionalText(2000),
  }),
  z.object({
    /** Where the property was found: agent, portal URL or reference. Required for external entries. */
    externalReference: z.string().trim().min(3).max(500),
    title: z.string().trim().min(3).max(200),
    /** Asking price as stated by the source; omit when not disclosed. */
    priceKobo: positiveKobo.optional(),
    notes: optionalText(2000),
  }),
]);
export type ShortlistItemAdd = z.infer<typeof shortlistItemAddSchema>;

export const shortlistItemUpdateSchema = z.object({
  notes: z.string().trim().max(2000).nullable().optional(),
  status: shortlistItemStatusSchema.optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  /** External entries only. */
  title: z.string().trim().min(3).max(200).optional(),
  externalReference: z.string().trim().min(3).max(500).optional(),
  priceKobo: positiveKobo.nullable().optional(),
});
export type ShortlistItemUpdate = z.infer<typeof shortlistItemUpdateSchema>;

export const shortlistItemFeedbackSchema = z
  .object({
    rating: z.number().int().min(1).max(5).nullable().optional(),
    feedback: z.string().trim().max(2000).nullable().optional(),
    /** The customer marks an entry preferred or not for them. */
    preference: z.enum(['preferred', 'rejected', 'candidate']).optional(),
  })
  .refine((v) => v.rating !== undefined || v.feedback !== undefined || v.preference, {
    message: 'give a rating, feedback or a preference',
  });
export type ShortlistItemFeedback = z.infer<typeof shortlistItemFeedbackSchema>;

export const shortlistAcceptSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  note: optionalText(2000),
});
export type ShortlistAccept = z.infer<typeof shortlistAcceptSchema>;

export const shortlistOutcomeSchema = z.object({
  outcome: searchOutcomeSchema,
  summary: z.string().trim().min(10).max(8000),
  expectedUpdatedAt: expectedUpdatedAtSchema,
});
export type ShortlistOutcomeInput = z.infer<typeof shortlistOutcomeSchema>;

const comparedString = z.object({
  value: z.string().nullable(),
  source: z.enum(['listing', 'shortlist_entry']).nullable(),
});

export const comparisonVerificationSchema = z.object({
  value: z
    .object({
      checks: z.array(
        z.object({
          item: z.string(),
          result: z.string().nullable().optional(),
          checkedBy: z.string().nullable().optional(),
          checkedAt: z.string().nullable().optional(),
          expiresAt: z.string().nullable().optional(),
        }),
      ),
      summary: z.string().nullable(),
    })
    .nullable(),
  source: z.enum(['listing', 'shortlist_entry']).nullable(),
});

export const shortlistComparisonSchema = z.object({
  price: comparedString,
  priceBasis: comparedString,
  area: comparedString,
  tenure: comparedString,
  titleDisclosure: comparedString,
  verification: comparisonVerificationSchema,
  locationPrecision: comparedString,
  location: comparedString,
  availability: comparedString,
});
export type ShortlistComparisonDto = z.infer<typeof shortlistComparisonSchema>;

export const shortlistItemDtoSchema = z.object({
  id: uuidSchema,
  shortlistId: uuidSchema,
  listingId: uuidSchema.nullable(),
  listingSlug: z.string().nullable(),
  /** False when the listing is no longer published (its facts are then withheld). */
  listingPublished: z.boolean().nullable(),
  externalReference: z.string().nullable(),
  title: z.string(),
  notes: z.string().nullable(),
  customerRating: z.number().int().nullable(),
  customerFeedback: z.string().nullable(),
  status: shortlistItemStatusSchema,
  sortOrder: z.number().int(),
  comparison: shortlistComparisonSchema,
  createdAt: isoDateTimeSchema,
});
export type ShortlistItemDto = z.infer<typeof shortlistItemDtoSchema>;

export const shortlistOutcomeDtoSchema = z.object({
  outcome: searchOutcomeSchema,
  summary: z.string(),
  recordedAt: isoDateTimeSchema,
  recordedByName: z.string().nullable(),
  /** Item tallies computed from the shortlist at read time. */
  tallies: z.object({
    considered: z.number().int(),
    viewed: z.number().int(),
    preferred: z.number().int(),
    rejected: z.number().int(),
  }),
  /** Where the record lives: a released `search_outcome` report or the shortlist record. */
  reportId: uuidSchema.nullable(),
});
export type ShortlistOutcomeDto = z.infer<typeof shortlistOutcomeDtoSchema>;

export const shortlistDtoSchema = z.object({
  id: uuidSchema,
  serviceRequestId: uuidSchema.nullable(),
  name: z.string(),
  status: shortlistStatusSchema,
  items: z.array(shortlistItemDtoSchema),
  acceptance: z
    .object({ acceptedAt: isoDateTimeSchema, acceptedByName: z.string().nullable() })
    .nullable(),
  outcome: shortlistOutcomeDtoSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type ShortlistDto = z.infer<typeof shortlistDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Viewings                                                                */
/* ---------------------------------------------------------------------- */

export const viewingStatusSchema = z.enum([
  'requested',
  'confirmed',
  'completed',
  'cancelled',
  'no_show',
]);
export type ViewingStatusDto = z.infer<typeof viewingStatusSchema>;

export const viewingRequestSchema = z
  .object({
    /** A listing-backed shortlist entry to view. */
    shortlistItemId: uuidSchema.optional(),
    /** A `viewing` appointment already booked on this request (external properties). */
    appointmentId: uuidSchema.optional(),
    preferredTimes: optionalText(500),
  })
  .refine((v) => Boolean(v.shortlistItemId) || Boolean(v.appointmentId), {
    message: 'choose a shortlisted property or a booked viewing appointment',
    path: ['shortlistItemId'],
  });
export type ViewingRequest = z.infer<typeof viewingRequestSchema>;

export const viewingUpdateSchema = z.object({
  status: z.enum(['confirmed', 'completed', 'cancelled', 'no_show']).optional(),
  scheduledAt: isoDateTimeSchema.nullable().optional(),
  /** Link a booked `viewing` appointment of the same request. */
  appointmentId: uuidSchema.nullable().optional(),
  expectedUpdatedAt: expectedUpdatedAtSchema,
});
export type ViewingUpdate = z.infer<typeof viewingUpdateSchema>;

export const viewingFeedbackSchema = z.object({
  feedback: z.string().trim().min(3).max(4000),
  expectedUpdatedAt: expectedUpdatedAtSchema,
});
export type ViewingFeedback = z.infer<typeof viewingFeedbackSchema>;

export const viewingDtoSchema = z.object({
  id: uuidSchema,
  listingId: uuidSchema.nullable(),
  title: z.string(),
  status: viewingStatusSchema,
  scheduledAt: isoDateTimeSchema.nullable(),
  appointmentId: uuidSchema.nullable(),
  appointmentStatus: z.string().nullable(),
  feedback: z.string().nullable(),
  requestedByName: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type ViewingDto = z.infer<typeof viewingDtoSchema>;

export const searchWorkspaceDtoSchema = z.object({
  serviceRequestId: uuidSchema,
  shortlists: z.array(shortlistDtoSchema),
  viewings: z.array(viewingDtoSchema),
  /** Booked `viewing` appointments on the request not yet recorded as viewings. */
  unlinkedViewingAppointments: z.array(
    z.object({ id: uuidSchema, startsAt: isoDateTimeSchema, status: z.string() }),
  ),
  viewer: z.enum(['customer', 'staff']),
});
export type SearchWorkspaceDto = z.infer<typeof searchWorkspaceDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Offers                                                                  */
/* ---------------------------------------------------------------------- */

export const purchaseOfferStatusSchema = z.enum([
  'draft',
  'submitted',
  'countered',
  'accepted',
  'rejected',
  'withdrawn',
  'expired',
]);
export type PurchaseOfferStatus = z.infer<typeof purchaseOfferStatusSchema>;

export const purchaseOfferActionNameSchema = z.enum([
  'submit',
  'counter',
  'revise',
  'accept',
  'reject',
  'withdraw',
  'expire',
  'note',
]);
export type PurchaseOfferActionName = z.infer<typeof purchaseOfferActionNameSchema>;

export const purchaseOfferCreateSchema = z
  .object({
    /** A listing-backed or external shortlist entry of this request. */
    shortlistItemId: uuidSchema.optional(),
    /** A published listing (when not shortlisted). */
    listingId: uuidSchema.optional(),
    amountKobo: positiveKobo,
    /** Offer terms, e.g. "subject to survey"; tracked as conditions once accepted. */
    conditions: z.array(z.string().trim().min(2).max(300)).max(15).default([]),
    expiresAt: isoDateTimeSchema.nullable().optional(),
    note: optionalText(2000),
  })
  .refine((v) => Boolean(v.shortlistItemId) || Boolean(v.listingId), {
    message: 'choose the shortlisted property or listing the offer is for',
    path: ['shortlistItemId'],
  });
export type PurchaseOfferCreate = z.infer<typeof purchaseOfferCreateSchema>;

export const purchaseOfferUpdateSchema = z.object({
  amountKobo: positiveKobo.optional(),
  conditions: z.array(z.string().trim().min(2).max(300)).max(15).optional(),
  expiresAt: isoDateTimeSchema.nullable().optional(),
  /** Negotiation log length the caller saw (optimistic concurrency). */
  expectedEntries: z.number().int().min(1),
});
export type PurchaseOfferUpdate = z.infer<typeof purchaseOfferUpdateSchema>;

export const purchaseOfferActionSchema = z.object({
  action: purchaseOfferActionNameSchema,
  amountKobo: positiveKobo.optional(),
  note: optionalText(2000),
  expiresAt: isoDateTimeSchema.nullable().optional(),
  expectedEntries: z.number().int().min(1),
});
export type PurchaseOfferAction = z.infer<typeof purchaseOfferActionSchema>;

export const purchaseNegotiationEntrySchema = z.object({
  at: isoDateTimeSchema,
  byUserId: z.string().nullable(),
  byName: z.string().nullable(),
  action: z.string(),
  amountKobo: z.string().nullable(),
  note: z.string().nullable(),
  status: purchaseOfferStatusSchema.nullable(),
  actor: z.string().nullable(),
});
export type PurchaseNegotiationEntryDto = z.infer<typeof purchaseNegotiationEntrySchema>;

export const purchaseOfferDtoSchema = z.object({
  id: uuidSchema,
  serviceRequestId: uuidSchema,
  listingId: uuidSchema.nullable(),
  shortlistItemId: uuidSchema.nullable(),
  subjectTitle: z.string(),
  externalReference: z.string().nullable(),
  amountKobo: z.string(),
  currency: z.string(),
  conditions: z.array(z.string()),
  status: purchaseOfferStatusSchema,
  expiresAt: isoDateTimeSchema.nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  negotiationLog: z.array(purchaseNegotiationEntrySchema),
  /** Log length: pass back as `expectedEntries`. */
  entries: z.number().int(),
  availableActions: z.array(
    z.object({ action: purchaseOfferActionNameSchema, reasonRequired: z.boolean() }),
  ),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type PurchaseOfferDto = z.infer<typeof purchaseOfferDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Conditions, closing checklist and document handover                     */
/* ---------------------------------------------------------------------- */

export const purchaseItemKindSchema = z.enum(['condition', 'closing_task', 'handover_document']);
export type PurchaseItemKind = z.infer<typeof purchaseItemKindSchema>;

export const purchaseItemStatusSchema = z.enum([
  'open',
  'in_progress',
  'satisfied',
  'waived',
  'failed',
  'cancelled',
]);

export const purchaseItemCreateSchema = z.object({
  kind: purchaseItemKindSchema,
  title: z.string().trim().min(3).max(300),
  detail: optionalText(4000),
  reference: optionalText(300),
  dueAt: isoDateTimeSchema.nullable().optional(),
  visibility: z.enum(['customer', 'all', 'internal']).default('customer'),
  fileIds: z.array(uuidSchema).max(20).default([]),
});
export type PurchaseItemCreate = z.infer<typeof purchaseItemCreateSchema>;

export const purchaseItemUpdateSchema = z.object({
  status: purchaseItemStatusSchema.optional(),
  /** Required to waive, fail, cancel or reopen. */
  reason: optionalText(2000),
  title: z.string().trim().min(3).max(300).optional(),
  detail: z.string().trim().max(4000).nullable().optional(),
  reference: z.string().trim().max(300).nullable().optional(),
  dueAt: isoDateTimeSchema.nullable().optional(),
  /** Files to attach (handover documents, evidence); existing ids are kept. */
  addFileIds: z.array(uuidSchema).max(20).optional(),
  expectedVersion: z.number().int().min(1),
});
export type PurchaseItemUpdate = z.infer<typeof purchaseItemUpdateSchema>;

export const handoverAcknowledgeSchema = z.object({
  expectedVersion: z.number().int().min(1),
});
export type HandoverAcknowledge = z.infer<typeof handoverAcknowledgeSchema>;

export const purchaseItemDtoSchema = z.object({
  id: uuidSchema,
  kind: purchaseItemKindSchema,
  title: z.string(),
  detail: z.string().nullable(),
  reference: z.string().nullable(),
  status: purchaseItemStatusSchema,
  visibility: z.string(),
  dueAt: isoDateTimeSchema.nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
  resolvedByName: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  files: z.array(z.object({ id: uuidSchema, name: z.string(), status: z.string() })),
  /** Offer the condition came from, when any. */
  offerId: uuidSchema.nullable(),
  /** Handover documents: the customer acknowledged receipt. */
  acknowledged: z.boolean(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
});
export type PurchaseItemDto = z.infer<typeof purchaseItemDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Diligence dependency and closing                                        */
/* ---------------------------------------------------------------------- */

export const diligenceLinkSchema = z.object({
  diligenceRequestId: uuidSchema,
});
export type DiligenceLink = z.infer<typeof diligenceLinkSchema>;

export const diligenceWaiveSchema = z.object({
  reason: z.string().trim().min(10).max(2000),
});
export type DiligenceWaive = z.infer<typeof diligenceWaiveSchema>;

export const closingBlockerSchema = z.object({
  code: z.string(),
  message: z.string(),
  itemIds: z.array(uuidSchema).optional(),
});

export const diligenceDependencyDtoSchema = z.object({
  linked: z.boolean(),
  request: z
    .object({
      id: uuidSchema,
      reference: z.string(),
      title: z.string(),
      status: z.string(),
    })
    .nullable(),
  waived: z.boolean(),
  waiverReason: z.string().nullable(),
  /** Staff only: unresolved red flags (customers see the blocker, not internal counts). */
  openRedFlags: z.number().int().nullable(),
  memoReleased: z.boolean(),
  clear: z.boolean(),
  blockers: z.array(closingBlockerSchema),
  /** Due-diligence requests of the same customer that can be linked (staff). */
  candidates: z.array(
    z.object({ id: uuidSchema, reference: z.string(), title: z.string(), status: z.string() }),
  ),
});
export type DiligenceDependencyDto = z.infer<typeof diligenceDependencyDtoSchema>;

export const closingStepSchema = z.object({
  /** The service request version the caller loaded. */
  expectedVersion: z.number().int().min(1),
  note: optionalText(2000),
});
export type ClosingStep = z.infer<typeof closingStepSchema>;

export const closingRecordDtoSchema = z.object({
  /** The `closing_pack` report holding the record (reviewed and released like every report). */
  reportId: uuidSchema,
  reportStatus: z.string(),
  stage: z.enum(['submitted', 'approved']),
  at: isoDateTimeSchema,
  byName: z.string().nullable(),
  note: z.string().nullable(),
  handedOverDocuments: z.array(z.object({ id: uuidSchema, title: z.string() })),
  acceptedOfferId: uuidSchema.nullable(),
  feeBasis: z.unknown().nullable(),
});
export type ClosingRecordDto = z.infer<typeof closingRecordDtoSchema>;

export const purchaseFeeBasisDtoSchema = z.object({
  percentageBps: z.number().int().nullable(),
  basisAmountKobo: z.string().nullable(),
  basisDescription: z.string().nullable(),
  signedScopeFileId: uuidSchema.nullable(),
  agreedAt: isoDateTimeSchema.nullable(),
  /** Fee derived from the agreed basis only (null until agreed). */
  feeKobo: z.string().nullable(),
});
export type PurchaseFeeBasisDto = z.infer<typeof purchaseFeeBasisDtoSchema>;

export const purchaseWorkspaceDtoSchema = z.object({
  serviceRequestId: uuidSchema,
  serviceRequestVersion: z.number().int(),
  engagementStatus: z.string(),
  offers: z.array(purchaseOfferDtoSchema),
  conditions: z.array(purchaseItemDtoSchema),
  closingTasks: z.array(purchaseItemDtoSchema),
  handoverDocuments: z.array(purchaseItemDtoSchema),
  diligence: diligenceDependencyDtoSchema,
  readiness: z.object({ ready: z.boolean(), blockers: z.array(closingBlockerSchema) }),
  feeBasis: purchaseFeeBasisDtoSchema,
  closing: z.array(closingRecordDtoSchema),
  viewer: z.enum(['customer', 'staff']),
});
export type PurchaseWorkspaceDto = z.infer<typeof purchaseWorkspaceDtoSchema>;
