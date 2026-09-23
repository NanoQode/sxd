import { z } from 'zod';
import {
  dateOnlySchema,
  evidenceBadgeSchema,
  isoDateTimeSchema,
  slugSchema,
  uuidSchema,
} from './common';

/**
 * Public and admin contracts for markets (the 50-location explorer),
 * observations, supplier leads and evidence panels. Every figure carries its
 * provenance and badge; unknown values stay null.
 */

export const geopoliticalZoneSchema = z.enum(['NC', 'NE', 'NW', 'SE', 'SS', 'SW']);
export const serviceAvailabilitySchema = z.enum([
  'pending_operations_confirmation',
  'available',
  'limited',
  'on_request',
  'unavailable',
]);
export const publicationStateSchema = z.enum([
  'draft',
  'in_review',
  'published',
  'unpublished',
  'archived',
]);
export const recommendationStatusSchema = z.enum([
  'insufficient_local_evidence',
  'assumption_mode_only',
  'eligible',
  'gated_by_policy',
]);
export const geographyLevelSchema = z.enum([
  'country',
  'state_or_fct',
  'city',
  'neighborhood',
  'site',
]);
export const freshnessSchema = z.enum(['fresh', 'stale', 'unknown']);

export const lonLatSchema = z.object({ lon: z.number(), lat: z.number() });

export const sourceRefSchema = z.object({
  id: uuidSchema,
  slug: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  licenseNote: z.string().nullable(),
  retrievedAt: dateOnlySchema.nullable(),
});
export type SourceRefDto = z.infer<typeof sourceRefSchema>;

export const observationDtoSchema = z.object({
  id: uuidSchema,
  slug: z.string().nullable(),
  metric: z.string(),
  value: z.number().nullable(),
  valueLow: z.number().nullable(),
  valueHigh: z.number().nullable(),
  valueText: z.string().nullable(),
  unit: z.string(),
  currency: z.string().nullable(),
  numericRepresentation: z.string(),
  statistic: z.string(),
  propertyCohort: z.string(),
  geographyLevel: geographyLevelSchema,
  geographyLabel: z.string(),
  marketId: uuidSchema.nullable(),
  stateId: uuidSchema.nullable(),
  observationPeriodStart: dateOnlySchema.nullable(),
  observationPeriodEnd: dateOnlySchema.nullable(),
  periodCompleteAtRetrieval: z.boolean().nullable(),
  sourceUpdatedAt: dateOnlySchema.nullable(),
  retrievedAt: dateOnlySchema,
  validUntil: dateOnlySchema.nullable(),
  sampleSize: z.number().int().nullable(),
  collectionMethod: z.string().nullable(),
  source: sourceRefSchema,
  badge: evidenceBadgeSchema,
  freshness: freshnessSchema,
  reviewStatus: z.string(),
  publicationState: publicationStateSchema,
  rankEligible: z.boolean(),
  reasonNotRankEligible: z.string().nullable(),
  editorialNote: z.string().nullable(),
  interpretationVersion: z.number().int(),
});
export type ObservationDto = z.infer<typeof observationDtoSchema>;

export const supplierLeadDtoSchema = z.object({
  facilityId: uuidSchema,
  slug: z.string(),
  name: z.string(),
  operator: z.string().nullable(),
  material: z.string(),
  stateName: z.string().nullable(),
  evidenceStatus: z.string(),
  stockStatus: z.string(),
  deliveryCoverageVerified: z.boolean(),
  relation: z.string(),
  note: z.string().nullable(),
  badge: evidenceBadgeSchema,
  source: sourceRefSchema.nullable(),
});
export type SupplierLeadDto = z.infer<typeof supplierLeadDtoSchema>;

export const supplierQuoteDtoSchema = z.object({
  id: uuidSchema,
  material: z.string(),
  specification: z.string(),
  unit: z.string(),
  quantity: z.string().nullable(),
  unitPrice: z.object({ amountKobo: z.string(), currency: z.string() }).nullable(),
  deliveryCost: z.object({ amountKobo: z.string(), currency: z.string() }).nullable(),
  leadTimeDays: z.number().int().nullable(),
  quotedAt: dateOnlySchema,
  validUntil: dateOnlySchema.nullable(),
  freshness: freshnessSchema,
  badge: evidenceBadgeSchema,
  rankEligible: z.boolean(),
});
export type SupplierQuoteDto = z.infer<typeof supplierQuoteDtoSchema>;

export const marketMetricDtoSchema = z.object({
  metric: z.string(),
  value: z.number().nullable(),
  unit: z.string().nullable(),
  badge: evidenceBadgeSchema,
  observedAt: dateOnlySchema.nullable(),
  geographyLevel: geographyLevelSchema.nullable(),
  sourceTitle: z.string().nullable(),
  sampleSize: z.number().int().nullable(),
  freshness: freshnessSchema,
  note: z.string().nullable(),
});
export type MarketMetricDto = z.infer<typeof marketMetricDtoSchema>;

export const evidenceSummarySchema = z.object({
  localObservations: z.number().int(),
  regionalContextObservations: z.number().int(),
  supplierLeads: z.number().int(),
  supplierQuotes: z.number().int(),
  openResearchTasks: z.number().int(),
  lastReviewedAt: isoDateTimeSchema.nullable(),
  lastResearchedAt: dateOnlySchema.nullable(),
  freshness: freshnessSchema,
  badges: z.array(evidenceBadgeSchema),
});
export type EvidenceSummaryDto = z.infer<typeof evidenceSummarySchema>;

export const serviceCoverageDtoSchema = z.object({
  serviceSlug: slugSchema,
  serviceName: z.string(),
  availability: serviceAvailabilitySchema,
  note: z.string().nullable(),
});

export const marketFlagDtoSchema = z.object({
  id: uuidSchema,
  flagType: z.string(),
  note: z.string(),
  validFrom: dateOnlySchema.nullable(),
  validUntil: dateOnlySchema.nullable(),
  active: z.boolean(),
});

export const marketSummarySchema = z.object({
  id: uuidSchema,
  slug: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  stateId: uuidSchema,
  stateName: z.string(),
  isFederalCapital: z.boolean(),
  geopoliticalZone: geopoliticalZoneSchema,
  displayOrder: z.number().int(),
  location: lonLatSchema,
  coordinateAccuracy: z.string().nullable(),
  parentMarketId: uuidSchema.nullable(),
  overlapNote: z.string().nullable(),
  serviceAvailability: serviceAvailabilitySchema,
  publicationState: publicationStateSchema,
  recommendationStatus: recommendationStatusSchema,
  evidence: evidenceSummarySchema,
  metrics: z.record(z.string(), marketMetricDtoSchema.nullable()),
  version: z.number().int(),
});
export type MarketSummaryDto = z.infer<typeof marketSummarySchema>;

export const neighborhoodDtoSchema = z.object({
  id: uuidSchema,
  slug: z.string(),
  name: z.string(),
  hasBoundary: z.boolean(),
  centroid: lonLatSchema.nullable(),
  publicationState: publicationStateSchema,
  profileMarkdown: z.string().nullable(),
  version: z.number().int(),
});

export const marketDetailSchema = marketSummarySchema.extend({
  selectionBasis: z.string().nullable(),
  coordinateSource: sourceRefSchema.nullable(),
  sourceCityName: z.string().nullable(),
  profileMarkdown: z.string().nullable(),
  supplyMappingMethod: z.string().nullable(),
  researchTasks: z.array(
    z.object({ id: uuidSchema, title: z.string(), category: z.string(), status: z.string() }),
  ),
  neighborhoods: z.array(neighborhoodDtoSchema),
  localObservations: z.array(observationDtoSchema),
  regionalContextObservations: z.array(observationDtoSchema),
  supplierLeads: z.array(supplierLeadDtoSchema),
  supplierQuotes: z.array(supplierQuoteDtoSchema),
  serviceCoverage: z.array(serviceCoverageDtoSchema),
  flags: z.array(marketFlagDtoSchema),
  missingEvidence: z.array(z.string()),
  timelineTemplate: z
    .object({
      key: z.string(),
      name: z.string(),
      status: z.string(),
      canComputeCompletionDate: z.boolean(),
      missingInputs: z.array(z.string()),
      assumptionNotes: z.string().nullable(),
    })
    .nullable(),
  lastReviewedAt: isoDateTimeSchema.nullable(),
  publishedAt: isoDateTimeSchema.nullable(),
  importedAt: isoDateTimeSchema.nullable(),
  humanEditedAt: isoDateTimeSchema.nullable(),
});
export type MarketDetailDto = z.infer<typeof marketDetailSchema>;

/** Query for GET /api/v1/markets. `bbox` is "minLon,minLat,maxLon,maxLat" in WGS84. */
export const marketListQuerySchema = z.object({
  bbox: z
    .string()
    .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
    .optional(),
  objective: z
    .enum([
      'owner_occupation',
      'long_term_rent',
      'development_for_sale',
      'student_housing',
      'commercial',
      'short_stay',
    ])
    .optional(),
  evidenceStatus: z.enum(['any', 'has_local', 'has_regional', 'none', 'stale']).default('any'),
  zone: geopoliticalZoneSchema.optional(),
  stateId: uuidSchema.optional(),
  serviceAvailability: serviceAvailabilitySchema.optional(),
  q: z.string().max(80).optional(),
  /** Staff only: include unpublished markets. */
  includeUnpublished: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type MarketListQuery = z.infer<typeof marketListQuerySchema>;

export const marketListResponseSchema = z.object({
  items: z.array(marketSummarySchema),
  total: z.number().int(),
  policy: z.object({
    activeRankingPolicyVersion: z.number().int().nullable(),
    defaultFinancialRankingEnabled: z.boolean(),
    coverageThreshold: z.number(),
  }),
  generatedAt: isoDateTimeSchema,
});
export type MarketListResponse = z.infer<typeof marketListResponseSchema>;

/** GeoJSON FeatureCollection of published markets for the map layer. */
export const marketGeoJsonSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(
    z.object({
      type: z.literal('Feature'),
      id: z.string(),
      geometry: z.object({
        type: z.literal('Point'),
        coordinates: z.tuple([z.number(), z.number()]),
      }),
      properties: z.object({
        id: uuidSchema,
        slug: z.string(),
        name: z.string(),
        stateName: z.string(),
        zone: geopoliticalZoneSchema,
        serviceAvailability: serviceAvailabilitySchema,
        recommendationStatus: recommendationStatusSchema,
        evidenceFreshness: freshnessSchema,
        localObservations: z.number().int(),
        regionalContextObservations: z.number().int(),
        parentMarketId: uuidSchema.nullable(),
      }),
    }),
  ),
});
export type MarketGeoJson = z.infer<typeof marketGeoJsonSchema>;

/* ---------------------------------------------------------------------- */
/* Admin write contracts                                                   */
/* ---------------------------------------------------------------------- */

export const marketUpsertSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(120),
  aliases: z.array(z.string().min(1).max(120)).max(20).default([]),
  stateId: uuidSchema,
  geopoliticalZone: geopoliticalZoneSchema,
  displayOrder: z.number().int().min(0).default(0),
  selectionBasis: z.string().max(500).nullable().optional(),
  location: lonLatSchema,
  coordinateSourceId: uuidSchema.nullable().optional(),
  coordinateAccuracy: z.string().max(200).nullable().optional(),
  parentMarketId: uuidSchema.nullable().optional(),
  overlapNote: z.string().max(500).nullable().optional(),
  serviceAvailability: serviceAvailabilitySchema.default('pending_operations_confirmation'),
  profileMarkdown: z.string().max(20_000).nullable().optional(),
  supplyMappingMethod: z.string().max(500).nullable().optional(),
  changeReason: z.string().max(500).optional(),
});
export type MarketUpsert = z.infer<typeof marketUpsertSchema>;

export const marketPatchSchema = marketUpsertSchema.partial().extend({
  expectedVersion: z.number().int().min(1),
  changeReason: z.string().min(3).max(500),
});

export const observationCreateSchema = z.object({
  sourceId: uuidSchema,
  sourceUrl: z.string().url().nullable().optional(),
  metric: z.string().min(1).max(80),
  value: z.number().finite().nullable().optional(),
  valueLow: z.number().finite().nullable().optional(),
  valueHigh: z.number().finite().nullable().optional(),
  valueText: z.string().max(500).nullable().optional(),
  unit: z.string().min(1).max(60),
  currency: z.string().length(3).nullable().optional(),
  numericRepresentation: z.enum([
    'whole_naira_not_kobo',
    'kobo',
    'percent',
    'days',
    'count',
    'text',
    'other',
  ]),
  geographyLevel: geographyLevelSchema,
  geographyLabel: z.string().min(1).max(120),
  stateId: uuidSchema.nullable().optional(),
  marketId: uuidSchema.nullable().optional(),
  neighborhoodId: uuidSchema.nullable().optional(),
  propertyCohort: z.string().min(1).max(120),
  statistic: z.enum([
    'median',
    'mean',
    'min',
    'max',
    'range',
    'count',
    'categorical',
    'quote',
    'single_observation',
  ]),
  observationPeriodStart: dateOnlySchema.nullable().optional(),
  observationPeriodEnd: dateOnlySchema.nullable().optional(),
  periodCompleteAtRetrieval: z.boolean().nullable().optional(),
  sourceUpdatedAt: dateOnlySchema.nullable().optional(),
  retrievedAt: dateOnlySchema,
  sampleSize: z.number().int().nonnegative().nullable().optional(),
  collectionMethod: z.string().max(120).nullable().optional(),
  licenseNote: z.string().max(500).nullable().optional(),
  validUntil: dateOnlySchema.nullable().optional(),
  evidenceFileId: uuidSchema.nullable().optional(),
  editorialNote: z.string().max(2000).nullable().optional(),
});
export type ObservationCreate = z.infer<typeof observationCreateSchema>;

export const observationReviewSchema = z.object({
  decision: z.enum([
    'approve',
    'reject',
    'dispute',
    'mark_stale',
    'publish',
    'unpublish',
    'mark_rank_eligible',
    'mark_rank_ineligible',
  ]),
  note: z.string().max(2000).optional(),
  reasonNotRankEligible: z.string().max(500).optional(),
  expectedVersion: z.number().int().min(1),
});

export const importPreviewResponseSchema = z.object({
  importId: uuidSchema,
  summary: z.unknown(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
  conflicts: z.array(z.object({ entity: z.string(), id: z.string(), reason: z.string() })),
});

/* ---------------------------------------------------------------------- */
/* Read-model additions (states, observation pages)                        */
/* ---------------------------------------------------------------------- */

/** GET /api/v1/states: every state with the number of markets visible to the caller. */
export const stateWithCountsSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  geopoliticalZone: geopoliticalZoneSchema,
  isFederalCapital: z.boolean(),
  marketCount: z.number().int().nonnegative(),
});
export type StateWithCountsDto = z.infer<typeof stateWithCountsSchema>;

export const stateListResponseSchema = z.object({ items: z.array(stateWithCountsSchema) });

/** GET /api/v1/markets/:idOrSlug/observations: cursor-paginated evidence panel rows. */
export const marketObservationsQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** local = city/neighbourhood/site rows for the market; regional = statewide/national context. */
  scope: z.enum(['all', 'local', 'regional']).default('all'),
});
export type MarketObservationsQuery = z.infer<typeof marketObservationsQuerySchema>;

export const marketObservationsPageSchema = z.object({
  items: z.array(observationDtoSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
  market: z.object({ id: uuidSchema, slug: z.string(), name: z.string(), stateName: z.string() }),
});
export type MarketObservationsPage = z.infer<typeof marketObservationsPageSchema>;
