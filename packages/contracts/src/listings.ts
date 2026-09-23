import { z } from 'zod';
import {
  dateOnlySchema,
  emailSchema,
  expectedVersionSchema,
  isoDateTimeSchema,
  phoneE164Schema,
  uuidSchema,
} from './common';
import { propertyKindSchema } from './properties';

/**
 * Listings, moderation, public search, inquiries, offers and land
 * sales/leasing transaction tracking (brief §8, §19, §20).
 *
 * A listing belongs to the organisation that owns the property. Every edit
 * creates a new immutable revision (`currentVersion`); staff publish one
 * specific revision (`publishedVersion`). Prices are optional and never
 * invented: an empty price reads "price on request". Locations are published
 * at the approved precision only; exact coordinates need staff approval.
 */

export const listingKindSchema = z.enum(['sale', 'lease', 'short_stay']);
export type ListingKind = z.infer<typeof listingKindSchema>;

export const listingStatusSchema = z.enum([
  'draft',
  'in_moderation',
  'published',
  'paused',
  'expired',
  'withdrawn',
  'archived',
  'rejected',
]);
export type ListingStatus = z.infer<typeof listingStatusSchema>;

/** Land tenure under the Land Use Act, plus leases; `other` is explained in the title disclosure. */
export const listingTenureSchema = z.enum([
  'statutory_right_of_occupancy',
  'customary_right_of_occupancy',
  'leasehold',
  'sublease',
  'other',
]);
export type ListingTenure = z.infer<typeof listingTenureSchema>;

export const LISTING_TENURE_LABELS: Record<ListingTenure, string> = {
  statutory_right_of_occupancy: 'Statutory right of occupancy',
  customary_right_of_occupancy: 'Customary right of occupancy',
  leasehold: 'Leasehold',
  sublease: 'Sublease',
  other: 'Other (see title disclosure)',
};

export const listingPriceBasisSchema = z.enum([
  'outright',
  'per_year',
  'per_month',
  'per_night',
  'per_plot',
  'per_m2',
]);
export type ListingPriceBasis = z.infer<typeof listingPriceBasisSchema>;

export const LISTING_PRICE_BASIS_LABELS: Record<ListingPriceBasis, string> = {
  outright: 'outright',
  per_year: 'per year',
  per_month: 'per month',
  per_night: 'per night',
  per_plot: 'per plot',
  per_m2: 'per m²',
};

/**
 * How precisely the public page may locate the property. `market` is the
 * default; `exact` publishes coordinates and needs explicit staff approval.
 */
export const listingLocationPrecisionSchema = z.enum(['state', 'market', 'neighborhood', 'exact']);
export type ListingLocationPrecision = z.infer<typeof listingLocationPrecisionSchema>;

export const LOCATION_PRECISION_RANK: Record<ListingLocationPrecision, number> = {
  state: 0,
  market: 1,
  neighborhood: 2,
  exact: 3,
};

/** `now`, or the calendar date from which the property is available. */
export const listingAvailabilitySchema = z.union([z.literal('now'), dateOnlySchema]);
export type ListingAvailability = z.infer<typeof listingAvailabilitySchema>;

/** What a verification check covered. Checks are recorded by staff with a date and expiry. */
export const verificationCheckItemSchema = z.enum([
  'owner_authority',
  'title_document_sighted',
  'registry_search',
  'survey_plan_sighted',
  'site_visit',
  'media_reviewed',
]);
export type VerificationCheckItem = z.infer<typeof verificationCheckItemSchema>;

export const VERIFICATION_CHECK_LABELS: Record<VerificationCheckItem, string> = {
  owner_authority: 'Owner authority document reviewed',
  title_document_sighted: 'Title document sighted (copy)',
  registry_search: 'Land registry search',
  survey_plan_sighted: 'Survey plan sighted',
  site_visit: 'Site visit',
  media_reviewed: 'Listing photos compared with the site',
};

export const verificationCheckOutcomeSchema = z.enum(['passed', 'issue_found', 'inconclusive']);
export type VerificationCheckOutcome = z.infer<typeof verificationCheckOutcomeSchema>;

/** Integer kobo as a decimal string (no sign, no fraction). */
export const positiveKoboStringSchema = z
  .string()
  .regex(/^[1-9]\d{0,15}$/, 'a positive whole number of kobo, as a string');

const areaM2Schema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'square metres with at most two decimals')
  .refine((v) => Number(v) > 0, 'must be greater than zero');

const listingContentShape = {
  title: z.string().trim().min(8).max(140),
  descriptionMarkdown: z.string().trim().max(8000).nullable().optional(),
  /** Optional: an empty price is shown as "price on request", never estimated. */
  priceKobo: positiveKoboStringSchema.nullable().optional(),
  priceBasis: listingPriceBasisSchema.nullable().optional(),
  areaM2: areaM2Schema.nullable().optional(),
  tenure: listingTenureSchema.nullable().optional(),
  /** What the owner discloses about title: documents held, encumbrances, pending consents. */
  titleDisclosure: z.string().trim().max(2000).nullable().optional(),
  availability: listingAvailabilitySchema.default('now'),
  /** Clean image files of the owning organisation; only publicly approved derivatives are shown. */
  mediaFileIds: z.array(uuidSchema).max(20).default([]),
  publicLocationPrecision: listingLocationPrecisionSchema.default('market'),
};

function priceRule(
  v: { priceKobo?: string | null; priceBasis?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (v.priceKobo && !v.priceBasis) {
    ctx.addIssue({
      code: 'custom',
      path: ['priceBasis'],
      message: 'state the basis of the price (outright, per year, per plot...)',
    });
  }
  if (!v.priceKobo && v.priceBasis) {
    ctx.addIssue({
      code: 'custom',
      path: ['priceKobo'],
      message: 'a price basis needs a price; leave both empty for "price on request"',
    });
  }
}

export const listingContentSchema = z.object(listingContentShape).superRefine(priceRule);
export type ListingContent = z.infer<typeof listingContentSchema>;

export const listingCreateSchema = z
  .object({ propertyId: uuidSchema, kind: listingKindSchema, ...listingContentShape })
  .superRefine(priceRule);
export type ListingCreate = z.infer<typeof listingCreateSchema>;

/** Each save is a complete new revision (the previous revisions are kept). */
export const listingUpdateSchema = z
  .object({ expectedVersion: expectedVersionSchema, ...listingContentShape })
  .superRefine(priceRule);
export type ListingUpdate = z.infer<typeof listingUpdateSchema>;

export const listingVersionOnlySchema = z.object({ expectedVersion: expectedVersionSchema });
export type ListingVersionOnly = z.infer<typeof listingVersionOnlySchema>;

export const listingReasonSchema = z.object({
  expectedVersion: expectedVersionSchema,
  reason: z.string().trim().min(3).max(2000),
});
export type ListingReason = z.infer<typeof listingReasonSchema>;

export const listingApproveSchema = z.object({
  expectedVersion: expectedVersionSchema,
  /** The revision being published; approving a revision other than the one reviewed is refused. */
  revisionVersion: z.number().int().min(1),
  /** Required to publish a revision that asks for exact coordinates. */
  approveExactLocation: z.boolean().default(false),
  note: z.string().trim().max(2000).nullable().optional(),
});
export type ListingApprove = z.infer<typeof listingApproveSchema>;

export const listingMarkDuplicateSchema = z.object({
  expectedVersion: expectedVersionSchema,
  duplicateOfListingId: uuidSchema,
  reason: z.string().trim().min(3).max(2000),
});
export type ListingMarkDuplicate = z.infer<typeof listingMarkDuplicateSchema>;

export const verificationCheckCreateSchema = z.object({
  item: verificationCheckItemSchema,
  outcome: verificationCheckOutcomeSchema,
  /** What was seen or found, in words the public can read. */
  result: z.string().trim().min(3).max(500),
  /** When the check was performed; defaults to now and may not be in the future. */
  checkedAt: isoDateTimeSchema.optional(),
  /** When the check should no longer be relied on. */
  expiresAt: isoDateTimeSchema.nullable().optional(),
  /** Optional replacement for the scope summary shown above the checks. */
  summary: z.string().trim().max(1000).optional(),
});
export type VerificationCheckCreate = z.infer<typeof verificationCheckCreateSchema>;

export const verificationCheckDtoSchema = z.object({
  item: z.string(),
  label: z.string(),
  outcome: verificationCheckOutcomeSchema.nullable(),
  result: z.string(),
  /** Name of the staff member (or the team) who performed the check. */
  checkedBy: z.string(),
  checkedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema.nullable(),
});
export type VerificationCheckDto = z.infer<typeof verificationCheckDtoSchema>;

export const listingRevisionDtoSchema = z.object({
  version: z.number().int(),
  title: z.string(),
  descriptionMarkdown: z.string().nullable(),
  priceKobo: z.string().nullable(),
  priceBasis: z.string().nullable(),
  currency: z.string(),
  areaM2: z.string().nullable(),
  tenure: z.string().nullable(),
  titleDisclosure: z.string().nullable(),
  availability: z.string().nullable(),
  verification: z.object({
    checks: z.array(verificationCheckDtoSchema),
    summary: z.string().nullable(),
  }),
  mediaFileIds: z.array(uuidSchema),
  publicLocationPrecision: listingLocationPrecisionSchema,
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type ListingRevisionDto = z.infer<typeof listingRevisionDtoSchema>;

export const listingSummaryDtoSchema = z.object({
  id: uuidSchema,
  slug: z.string(),
  organizationId: z.string(),
  organizationName: z.string().nullable(),
  propertyId: uuidSchema,
  propertyName: z.string().nullable(),
  propertyKind: propertyKindSchema.nullable(),
  kind: listingKindSchema,
  status: listingStatusSchema,
  /** `expired` once a published listing's availability window has passed, even before the job runs. */
  effectiveStatus: listingStatusSchema,
  title: z.string(),
  currentVersion: z.number().int(),
  publishedVersion: z.number().int().nullable(),
  /** A newer revision than the published one exists. */
  hasUnpublishedChanges: z.boolean(),
  duplicateOfListingId: uuidSchema.nullable(),
  publishedAt: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  availabilityConfirmedAt: isoDateTimeSchema.nullable(),
  moderationNote: z.string().nullable(),
  version: z.number().int(),
  updatedAt: isoDateTimeSchema,
});
export type ListingSummaryDto = z.infer<typeof listingSummaryDtoSchema>;

export const listingMediaFileDtoSchema = z.object({
  id: uuidSchema,
  originalName: z.string(),
  status: z.string(),
  mime: z.string(),
  isPublicApproved: z.boolean(),
  altText: z.string().nullable(),
});
export type ListingMediaFileDto = z.infer<typeof listingMediaFileDtoSchema>;

export const listingAuthorityStateSchema = z.object({
  id: uuidSchema,
  ownerName: z.string(),
  status: z.string(),
  effectiveStatus: z.string(),
  verifiedAt: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
});

export const listingDetailDtoSchema = listingSummaryDtoSchema.extend({
  ownerAuthorityId: uuidSchema.nullable(),
  publishedBy: z.string().nullable(),
  moderatedBy: z.string().nullable(),
  duplicateOfSlug: z.string().nullable(),
  current: listingRevisionDtoSchema,
  published: listingRevisionDtoSchema.nullable(),
  revisions: z.array(
    z.object({
      version: z.number().int(),
      title: z.string(),
      createdBy: z.string().nullable(),
      createdAt: isoDateTimeSchema,
    }),
  ),
  /** The newest verified (and unexpired) authority for the property, or the newest one of any status. */
  ownerAuthority: listingAuthorityStateSchema.nullable(),
  media: z.array(listingMediaFileDtoSchema),
  /** Inquiry count only: contact details stay with SimplexD staff. */
  inquiries: z.object({ total: z.number().int(), lastAt: isoDateTimeSchema.nullable() }),
  offers: z.object({ total: z.number().int(), open: z.number().int() }),
});
export type ListingDetailDto = z.infer<typeof listingDetailDtoSchema>;

export const listingListQuerySchema = z.object({
  status: listingStatusSchema.optional(),
  /** Staff queue shortcut: in-moderation listings plus published listings with changes awaiting review. */
  queue: z.enum(['moderation']).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  propertyId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListingListQuery = z.infer<typeof listingListQuerySchema>;

export const listingExpiryRunDtoSchema = z.object({
  listingsExpired: z.number().int(),
  offersExpired: z.number().int(),
  listingIds: z.array(uuidSchema),
});
export type ListingExpiryRunDto = z.infer<typeof listingExpiryRunDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Public search                                                           */
/* ---------------------------------------------------------------------- */

export const publicListingSortSchema = z.enum(['newest', 'price_asc', 'price_desc', 'area_desc']);
export type PublicListingSort = z.infer<typeof publicListingSortSchema>;

/**
 * Public filters. Prices are whole naira and areas square metres; `check`
 * keeps listings with an unexpired, passed verification check of that kind.
 */
export const publicListingFiltersSchema = z.object({
  kind: listingKindSchema.optional(),
  type: propertyKindSchema.optional(),
  minPrice: z.number().int().nonnegative().optional(),
  maxPrice: z.number().int().nonnegative().optional(),
  minArea: z.number().nonnegative().optional(),
  maxArea: z.number().nonnegative().optional(),
  state: z.string().regex(/^[a-z0-9-]{2,80}$/).optional(),
  market: z.string().regex(/^[a-z0-9-]{2,120}$/).optional(),
  tenure: listingTenureSchema.optional(),
  title: z.literal('disclosed').optional(),
  available: z.literal('now').optional(),
  check: verificationCheckItemSchema.optional(),
  sort: publicListingSortSchema.default('newest'),
});
export type PublicListingFilters = z.infer<typeof publicListingFiltersSchema>;

export const publicListingLocationSchema = z.object({
  precision: listingLocationPrecisionSchema,
  stateName: z.string().nullable(),
  stateSlug: z.string().nullable(),
  marketName: z.string().nullable(),
  marketSlug: z.string().nullable(),
  neighborhoodName: z.string().nullable(),
  /** Present only when exact coordinates were approved. */
  point: z.object({ lat: z.number(), lon: z.number() }).nullable(),
});
export type PublicListingLocation = z.infer<typeof publicListingLocationSchema>;

export const publicListingDtoSchema = z.object({
  id: uuidSchema,
  slug: z.string(),
  kind: listingKindSchema,
  propertyKind: propertyKindSchema,
  title: z.string(),
  descriptionHtml: z.string().nullable(),
  priceKobo: z.string().nullable(),
  priceBasis: z.string().nullable(),
  currency: z.string(),
  areaM2: z.string().nullable(),
  tenure: z.string().nullable(),
  titleDisclosure: z.string().nullable(),
  availability: z.string().nullable(),
  availabilityConfirmedAt: isoDateTimeSchema.nullable(),
  verification: z.object({
    checks: z.array(verificationCheckDtoSchema),
    summary: z.string().nullable(),
  }),
  location: publicListingLocationSchema,
  media: z.array(
    z.object({ fileId: uuidSchema, altText: z.string(), caption: z.string().nullable() }),
  ),
  publishedAt: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
});
export type PublicListingDto = z.infer<typeof publicListingDtoSchema>;

export const publicListingMediaQuerySchema = z.object({
  variant: z.enum(['thumb', 'web']).default('web'),
});

/* ---------------------------------------------------------------------- */
/* Inquiries                                                               */
/* ---------------------------------------------------------------------- */

export const listingInquirySchema = z.object({
  contactName: z.string().trim().min(2).max(120),
  email: emailSchema,
  phoneE164: phoneE164Schema.nullable().optional(),
  message: z.string().trim().min(10).max(2000),
  /** Interested as buyer, tenant or agent acting for one. */
  interest: z.enum(['buy', 'lease', 'agent', 'other']).default('other'),
  marketingConsent: z.boolean().default(false),
  consentPolicyVersion: z.string().max(32).default('2026-09'),
  /** Honeypot: must stay empty. */
  website: z.string().max(0).optional(),
  /** Milliseconds between form render and submit; too fast is treated as spam. */
  elapsedMs: z.number().int().nonnegative().optional(),
});
export type ListingInquiry = z.infer<typeof listingInquirySchema>;

/* ---------------------------------------------------------------------- */
/* Offers                                                                  */
/* ---------------------------------------------------------------------- */

export const listingOfferStatusSchema = z.enum([
  'draft',
  'submitted',
  'countered',
  'accepted',
  'rejected',
  'withdrawn',
  'expired',
]);
export type ListingOfferStatus = z.infer<typeof listingOfferStatusSchema>;

export const listingOfferPartySchema = z.enum(['buyer', 'owner', 'system']);
export type ListingOfferParty = z.infer<typeof listingOfferPartySchema>;

/** One append-only negotiation step. */
export const listingNegotiationEntrySchema = z.object({
  at: isoDateTimeSchema,
  /** User id of the actor; null for the expiry job. */
  by: z.string().nullable(),
  party: listingOfferPartySchema,
  action: z.enum(['submitted', 'countered', 'accepted', 'rejected', 'withdrawn', 'expired']),
  amountKobo: z.string().nullable(),
  note: z.string().nullable(),
});
export type ListingNegotiationEntry = z.infer<typeof listingNegotiationEntrySchema>;

export const listingOfferCreateSchema = z.object({
  amountKobo: positiveKoboStringSchema,
  conditions: z.array(z.string().trim().min(2).max(300)).max(10).default([]),
  note: z.string().trim().max(2000).nullable().optional(),
  /** The offer lapses at this time if nobody decides. */
  validUntil: isoDateTimeSchema.nullable().optional(),
});
export type ListingOfferCreate = z.infer<typeof listingOfferCreateSchema>;

/** `expectedEntries` is the negotiation log length the caller saw (optimistic concurrency). */
export const listingOfferActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('counter'),
    expectedEntries: z.number().int().min(1),
    amountKobo: positiveKoboStringSchema,
    note: z.string().trim().max(2000).nullable().optional(),
    validUntil: isoDateTimeSchema.nullable().optional(),
  }),
  z.object({
    action: z.literal('accept'),
    expectedEntries: z.number().int().min(1),
    note: z.string().trim().max(2000).nullable().optional(),
  }),
  z.object({
    action: z.literal('reject'),
    expectedEntries: z.number().int().min(1),
    note: z.string().trim().min(3).max(2000),
  }),
  z.object({
    action: z.literal('withdraw'),
    expectedEntries: z.number().int().min(1),
    note: z.string().trim().max(2000).nullable().optional(),
  }),
]);
export type ListingOfferAction = z.infer<typeof listingOfferActionSchema>;

export const listingOfferActionNameSchema = z.enum(['counter', 'accept', 'reject', 'withdraw']);
export type ListingOfferActionName = z.infer<typeof listingOfferActionNameSchema>;

export const listingOfferDtoSchema = z.object({
  id: uuidSchema,
  listingId: uuidSchema,
  listingSlug: z.string().nullable(),
  listingTitle: z.string().nullable(),
  buyerOrganizationId: z.string(),
  buyerOrganizationName: z.string().nullable(),
  ownerOrganizationId: z.string().nullable(),
  ownerOrganizationName: z.string().nullable(),
  amountKobo: z.string(),
  currency: z.string(),
  conditions: z.array(z.string()),
  status: listingOfferStatusSchema,
  /** `expired` once the validity date passed on an open offer, before the job records it. */
  effectiveStatus: listingOfferStatusSchema,
  negotiationLog: z.array(listingNegotiationEntrySchema),
  expiresAt: isoDateTimeSchema.nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  serviceRequestId: uuidSchema.nullable(),
  /** Which side the caller is on; staff see both sides read-only. */
  viewerParty: z.enum(['buyer', 'owner', 'staff']),
  /** Actions the caller may take now. */
  nextActions: z.array(listingOfferActionNameSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type ListingOfferDto = z.infer<typeof listingOfferDtoSchema>;

export const listingOfferListQuerySchema = z.object({
  side: z.enum(['buyer', 'owner', 'all']).default('all'),
  status: listingOfferStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListingOfferListQuery = z.infer<typeof listingOfferListQuerySchema>;

/* ---------------------------------------------------------------------- */
/* Land sales / leasing transaction                                         */
/* ---------------------------------------------------------------------- */

export const leaseMilestoneStatusSchema = z.enum([
  'open',
  'in_progress',
  'satisfied',
  'waived',
  'failed',
  'cancelled',
]);
export type LeaseMilestoneStatus = z.infer<typeof leaseMilestoneStatusSchema>;

export const leaseMilestoneCreateSchema = z.object({
  /** Needed for the first item: the land sales/leasing request that represents the transaction. */
  serviceRequestId: uuidSchema.optional(),
  title: z.string().trim().min(3).max(160),
  detail: z.string().trim().max(2000).nullable().optional(),
  reference: z.string().trim().max(120).nullable().optional(),
  dueAt: isoDateTimeSchema.nullable().optional(),
});
export type LeaseMilestoneCreate = z.infer<typeof leaseMilestoneCreateSchema>;

export const leaseMilestoneUpdateSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    status: leaseMilestoneStatusSchema,
    resolutionNote: z.string().trim().max(2000).nullable().optional(),
    fileIds: z.array(uuidSchema).max(10).optional(),
  })
  .superRefine((v, ctx) => {
    if (['waived', 'failed', 'cancelled'].includes(v.status) && !v.resolutionNote) {
      ctx.addIssue({
        code: 'custom',
        path: ['resolutionNote'],
        message: 'explain why the milestone was waived, failed or cancelled',
      });
    }
  });
export type LeaseMilestoneUpdate = z.infer<typeof leaseMilestoneUpdateSchema>;

export const leaseMilestoneDtoSchema = z.object({
  id: uuidSchema,
  serviceRequestId: uuidSchema,
  title: z.string(),
  detail: z.string().nullable(),
  reference: z.string().nullable(),
  status: leaseMilestoneStatusSchema,
  dueAt: isoDateTimeSchema.nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
  resolvedBy: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  fileIds: z.array(uuidSchema),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type LeaseMilestoneDto = z.infer<typeof leaseMilestoneDtoSchema>;

export const listingOutcomeKindSchema = z.enum(['sold', 'leased', 'withdrawn']);
export type ListingOutcomeKind = z.infer<typeof listingOutcomeKindSchema>;

export const listingOutcomeSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    outcome: listingOutcomeKindSchema,
    serviceRequestId: uuidSchema.optional(),
    /** The accepted offer the sale or lease completed on, when there is one. */
    offerId: uuidSchema.nullable().optional(),
    fileIds: z.array(uuidSchema).max(10).default([]),
    note: z.string().trim().min(3).max(2000),
  })
  .superRefine((v, ctx) => {
    if (v.outcome !== 'withdrawn' && v.fileIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['fileIds'],
        message: 'attach the executed agreement, receipt or lease as evidence of the outcome',
      });
    }
  });
export type ListingOutcome = z.infer<typeof listingOutcomeSchema>;

export const listingOutcomeDtoSchema = z.object({
  id: uuidSchema,
  outcome: listingOutcomeKindSchema,
  note: z.string().nullable(),
  fileIds: z.array(uuidSchema),
  serviceRequestId: uuidSchema,
  recordedBy: z.string().nullable(),
  recordedAt: isoDateTimeSchema,
});
export type ListingOutcomeDto = z.infer<typeof listingOutcomeDtoSchema>;

export const listingTransactionDtoSchema = z.object({
  listingId: uuidSchema,
  /** The land sales/leasing request the milestones and outcome are attached to. */
  serviceRequest: z
    .object({ id: uuidSchema, reference: z.string(), title: z.string(), status: z.string() })
    .nullable(),
  /** Open land sales/leasing requests of the owning organisation that could be linked. */
  eligibleRequests: z.array(
    z.object({ id: uuidSchema, reference: z.string(), title: z.string(), status: z.string() }),
  ),
  milestones: z.array(leaseMilestoneDtoSchema),
  outcome: listingOutcomeDtoSchema.nullable(),
  acceptedOffer: z
    .object({ id: uuidSchema, amountKobo: z.string(), decidedAt: isoDateTimeSchema.nullable() })
    .nullable(),
});
export type ListingTransactionDto = z.infer<typeof listingTransactionDtoSchema>;
