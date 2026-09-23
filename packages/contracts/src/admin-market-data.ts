import { z } from 'zod';
import {
  dateOnlySchema,
  expectedVersionSchema,
  isoDateTimeSchema,
  slugSchema,
  uuidSchema,
} from './common';
import {
  geographyLevelSchema,
  geopoliticalZoneSchema,
  lonLatSchema,
  observationCreateSchema,
  observationReviewSchema,
  publicationStateSchema,
  recommendationStatusSchema,
  serviceAvailabilitySchema,
} from './markets';

/**
 * Admin console contracts for market-data administration, platform settings,
 * access management and the audit log. Every mutation carries a reason and,
 * where the row is versioned, the version the caller last saw.
 */

/* ---------------------------------------------------------------------- */
/* Shared                                                                  */
/* ---------------------------------------------------------------------- */

export const reasonSchema = z.string().trim().min(3).max(500);

/** Rows without a version counter use their last update timestamp as the concurrency token. */
export const expectedUpdatedAtSchema = isoDateTimeSchema.optional();

export const staffRoleSchema = z.enum([
  'super_admin',
  'operations_manager',
  'project_manager',
  'inspector',
  'finance',
  'data_editor',
  'data_approver',
  'content_editor',
  'support',
]);

/* ---------------------------------------------------------------------- */
/* Markets                                                                 */
/* ---------------------------------------------------------------------- */

export const adminMarketListQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  stateId: uuidSchema.optional(),
  zone: geopoliticalZoneSchema.optional(),
  publicationState: publicationStateSchema.optional(),
  serviceAvailability: serviceAvailabilitySchema.optional(),
  recommendationStatus: recommendationStatusSchema.optional(),
  /** Only markets with interpretations awaiting business review. */
  pendingReview: z.coerce.boolean().optional(),
  sort: z.enum(['name', 'state', 'updatedAt', 'displayOrder', 'publicationState']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type AdminMarketListQuery = z.infer<typeof adminMarketListQuerySchema>;

export const adminMarketRowSchema = z.object({
  id: uuidSchema,
  slug: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  stateId: uuidSchema,
  stateName: z.string(),
  geopoliticalZone: geopoliticalZoneSchema,
  displayOrder: z.number().int(),
  location: lonLatSchema,
  parentMarketId: uuidSchema.nullable(),
  serviceAvailability: serviceAvailabilitySchema,
  publicationState: publicationStateSchema,
  recommendationStatus: recommendationStatusSchema,
  localObservations: z.number().int(),
  pendingReviews: z.number().int(),
  openResearchTasks: z.number().int(),
  version: z.number().int(),
  humanEditedAt: isoDateTimeSchema.nullable(),
  importedAt: isoDateTimeSchema.nullable(),
  publishedAt: isoDateTimeSchema.nullable(),
  archivedAt: isoDateTimeSchema.nullable(),
  mergedIntoMarketId: uuidSchema.nullable(),
  updatedAt: isoDateTimeSchema,
});
export type AdminMarketRow = z.infer<typeof adminMarketRowSchema>;

export const adminMarketListResponseSchema = z.object({
  items: z.array(adminMarketRowSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});

/** Publication and lifecycle transitions: publish, unpublish, archive, restore. */
export const marketTransitionSchema = z.object({
  expectedVersion: expectedVersionSchema,
  reason: reasonSchema,
});

export const marketMoveSchema = z.object({
  location: lonLatSchema,
  coordinateSourceId: uuidSchema.nullable().optional(),
  coordinateAccuracy: z.string().max(200).nullable().optional(),
  expectedVersion: expectedVersionSchema,
  changeReason: reasonSchema,
});

export const marketMergeSchema = z.object({
  targetMarketId: uuidSchema,
  expectedVersion: expectedVersionSchema,
  reason: reasonSchema,
});

export const marketRollbackSchema = z.object({
  revisionVersion: z.number().int().min(1),
  expectedVersion: expectedVersionSchema,
  reason: reasonSchema,
});

export const marketBulkActionSchema = z.object({
  action: z.enum(['publish', 'unpublish']),
  marketIds: z.array(uuidSchema).min(1).max(200),
  reason: reasonSchema,
  /** When true nothing changes; the response lists what would happen per market. */
  preview: z.boolean().default(false),
});

export const marketRevisionDtoSchema = z.object({
  id: uuidSchema,
  marketId: uuidSchema,
  version: z.number().int(),
  snapshot: z.record(z.string(), z.unknown()),
  changeReason: z.string().nullable(),
  changedBy: z.string().nullable(),
  changedByName: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type MarketRevisionDto = z.infer<typeof marketRevisionDtoSchema>;

export const revisionCompareQuerySchema = z.object({
  /** Two revision versions to compare, e.g. "3,5". */
  compare: z
    .string()
    .regex(/^\d+,\d+$/)
    .optional(),
});

/* ---------------------------------------------------------------------- */
/* Neighborhoods, coverage, flags, research tasks, sources                 */
/* ---------------------------------------------------------------------- */

export const neighborhoodCreateSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1).max(120),
  /** GeoJSON MultiPolygon (or Polygon, promoted) as text; validated with PostGIS. */
  boundaryGeoJson: z.string().max(2_000_000).nullable().optional(),
  boundarySourceId: uuidSchema.nullable().optional(),
  boundaryNote: z.string().max(500).nullable().optional(),
  profileMarkdown: z.string().max(20_000).nullable().optional(),
  changeReason: reasonSchema.optional(),
});

export const neighborhoodPatchSchema = neighborhoodCreateSchema
  .partial()
  .extend({
    publicationState: publicationStateSchema.optional(),
    expectedVersion: expectedVersionSchema,
    changeReason: reasonSchema,
  });

export const serviceCoverageItemSchema = z.object({
  serviceId: uuidSchema,
  availability: serviceAvailabilitySchema,
  note: z.string().max(500).nullable().optional(),
  effectiveFrom: dateOnlySchema.nullable().optional(),
  effectiveTo: dateOnlySchema.nullable().optional(),
});

export const serviceCoverageUpdateSchema = z.object({
  items: z.array(serviceCoverageItemSchema).min(1).max(100),
  reason: reasonSchema,
});

export const marketFlagTypeSchema = z.enum([
  'geographic_exclusion',
  'title_stop',
  'site_restriction',
  'flood_alert',
  'security_advisory',
  'data_dispute',
]);

export const marketFlagCreateSchema = z.object({
  flagType: marketFlagTypeSchema,
  note: z.string().trim().min(3).max(2000),
  neighborhoodId: uuidSchema.nullable().optional(),
  sourceId: uuidSchema.nullable().optional(),
  validFrom: dateOnlySchema.nullable().optional(),
  validUntil: dateOnlySchema.nullable().optional(),
  active: z.boolean().default(true),
});

export const marketFlagPatchSchema = z.object({
  note: z.string().trim().min(3).max(2000).optional(),
  active: z.boolean().optional(),
  validFrom: dateOnlySchema.nullable().optional(),
  validUntil: dateOnlySchema.nullable().optional(),
  sourceId: uuidSchema.nullable().optional(),
  reason: reasonSchema,
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

export const researchTaskStatusSchema = z.enum([
  'open',
  'in_progress',
  'in_review',
  'done',
  'blocked',
]);

export const researchTaskCreateSchema = z.object({
  title: z.string().trim().min(3).max(200),
  category: z.string().trim().min(1).max(60),
  priority: z.number().int().min(1).max(5).default(3),
  assigneeUserId: z.string().max(64).nullable().optional(),
  reviewerUserId: z.string().max(64).nullable().optional(),
  /** Whole naira; stored as kobo. */
  budgetNaira: z.number().nonnegative().max(1e12).nullable().optional(),
  dueDate: dateOnlySchema.nullable().optional(),
  evidenceRightsNote: z.string().max(2000).nullable().optional(),
  targetCount: z.number().int().nonnegative().nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

export const researchTaskPatchSchema = researchTaskCreateSchema.partial().extend({
  status: researchTaskStatusSchema.optional(),
  completedCount: z.number().int().nonnegative().optional(),
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

export const licenseRightsSchema = z.enum([
  'unknown',
  'attribution_required',
  'licensed_commercial',
  'first_party',
  'restricted_factual_reference',
]);

export const sourceCreateSchema = z.object({
  slug: slugSchema,
  title: z.string().trim().min(2).max(200),
  publisher: z.string().max(200).nullable().optional(),
  url: z.string().url().max(2000).nullable().optional(),
  dataUrl: z.string().url().max(2000).nullable().optional(),
  licenseNote: z.string().max(1000).nullable().optional(),
  licenseRights: licenseRightsSchema.default('unknown'),
  useNote: z.string().max(1000).nullable().optional(),
  retrievedAt: dateOnlySchema.nullable().optional(),
});

export const sourcePatchSchema = sourceCreateSchema.partial().omit({ slug: true }).extend({
  reason: reasonSchema,
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

export const sourceListQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/* ---------------------------------------------------------------------- */
/* Observations                                                            */
/* ---------------------------------------------------------------------- */

export const observationReviewStatusSchema = z.enum([
  'source_read_pending_business_review',
  'verified',
  'disputed',
  'rejected',
  'superseded',
  'stale',
]);

export const observationListQuerySchema = z.object({
  reviewStatus: observationReviewStatusSchema.optional(),
  publicationState: publicationStateSchema.optional(),
  marketId: uuidSchema.optional(),
  stateId: uuidSchema.optional(),
  metric: z.string().trim().max(80).optional(),
  geographyLevel: geographyLevelSchema.optional(),
  rankEligible: z.coerce.boolean().optional(),
  q: z.string().trim().max(80).optional(),
  /** Default queue view: current interpretations awaiting business review. */
  pendingOnly: z.coerce.boolean().default(false),
  sort: z.enum(['createdAt', 'retrievedAt', 'metric']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ObservationListQuery = z.infer<typeof observationListQuerySchema>;

/** Optional stable slug lets CSV re-imports skip rows already present. */
export const observationCreateInputSchema = observationCreateSchema.extend({
  slug: slugSchema.optional(),
});
export type ObservationCreateInput = z.infer<typeof observationCreateInputSchema>;

export const observationReviewInputSchema = observationReviewSchema.extend({
  /**
   * Publish a local median that has fewer deduplicated comparables than the
   * configured minimum as contextual evidence (never rank-eligible).
   */
  publishAsContextual: z.boolean().default(false),
});
export type ObservationReviewInput = z.infer<typeof observationReviewInputSchema>;

export const comparableSummarySchema = z.object({
  applicable: z.boolean(),
  count: z.number().int(),
  minComparables: z.number().int(),
  /** Share of the comparables coming from the single largest source (0–1). */
  sourceConcentration: z.number().nullable(),
  largestSourceTitle: z.string().nullable(),
  satisfied: z.boolean(),
});
export type ComparableSummary = z.infer<typeof comparableSummarySchema>;

/* ---------------------------------------------------------------------- */
/* Imports and exports                                                     */
/* ---------------------------------------------------------------------- */

export const importFormatSchema = z.enum(['seed_json', 'observations_csv']);

export const importPreviewRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  format: importFormatSchema,
  /** File contents as text (JSON document or CSV). */
  content: z.string().min(1).max(12_000_000),
});
export type ImportPreviewRequest = z.infer<typeof importPreviewRequestSchema>;

export const importRowErrorSchema = z.object({
  row: z.number().int().nullable(),
  path: z.string(),
  message: z.string(),
});

export const importApplySchema = z.object({
  reason: reasonSchema.optional(),
});

export const importDtoSchema = z.object({
  id: uuidSchema,
  fileName: z.string(),
  format: z.string(),
  status: z.enum(['previewed', 'applied', 'failed', 'cancelled']),
  summary: z.record(z.string(), z.unknown()),
  rowErrors: z.array(importRowErrorSchema),
  conflicts: z.array(z.object({ entity: z.string(), id: z.string(), reason: z.string() })),
  uploadedBy: z.string().nullable(),
  uploadedByName: z.string().nullable(),
  appliedAt: isoDateTimeSchema.nullable(),
  appliedBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type ImportDto = z.infer<typeof importDtoSchema>;

export const exportQuerySchema = z.object({
  publicationState: publicationStateSchema.optional(),
  marketId: uuidSchema.optional(),
});

/* ---------------------------------------------------------------------- */
/* Policies                                                                */
/* ---------------------------------------------------------------------- */

export const metricBoundInputSchema = z.object({
  metric: z.string().min(1).max(60),
  direction: z.enum(['higher_is_better', 'lower_is_better']),
  unit: z.string().min(1).max(40),
  low: z.number(),
  high: z.number(),
  cohort: z.string().max(80).optional(),
  note: z.string().max(500).optional(),
});

export const rankingPolicyCreateSchema = z.object({
  name: z.string().trim().min(3).max(120),
  /** Copy from this version (defaults to the active policy). */
  fromVersion: z.number().int().min(1).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const rankingPolicyPatchSchema = z.object({
  name: z.string().trim().min(3).max(120).optional(),
  weights: z.record(z.string(), z.number()).optional(),
  metricBounds: z.array(metricBoundInputSchema).max(50).optional(),
  confidenceRubric: z.record(z.string(), z.unknown()).optional(),
  coverageThreshold: z.number().optional(),
  minComparables: z.number().int().nonnegative().optional(),
  hardConstraints: z.record(z.string(), z.unknown()).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  reason: reasonSchema.optional(),
});

export const rankingPolicyActivateSchema = z.object({
  reason: reasonSchema,
});

export const rankingPolicyDtoSchema = z.object({
  id: uuidSchema,
  version: z.number().int(),
  name: z.string(),
  status: z.enum(['draft', 'active', 'retired']),
  weights: z.record(z.string(), z.number()),
  metricBounds: z.array(metricBoundInputSchema),
  confidenceRubric: z.unknown(),
  coverageThreshold: z.number(),
  minComparables: z.number().int(),
  hardConstraints: z.unknown().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  activatedAt: isoDateTimeSchema.nullable(),
  retiredAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  errors: z.array(z.object({ metric: z.string().nullable(), message: z.string() })),
});
export type RankingPolicyDto = z.infer<typeof rankingPolicyDtoSchema>;

export const freshnessPolicyUpsertSchema = z.object({
  maxAgeDays: z.number().int().min(1).max(3650).nullable(),
  respectSourceValidity: z.boolean().default(true),
  note: z.string().max(500).nullable().optional(),
  reason: reasonSchema,
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

export const dataPolicyKeySchema = z.enum([
  'publication.min_comparables',
  'ranking.coverage_threshold',
  'ranking.require_local_cost_and_rent',
  'default_financial_ranking_enabled',
]);

export const dataPolicyPatchSchema = z.object({
  value: z.unknown(),
  reason: reasonSchema,
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

/* ---------------------------------------------------------------------- */
/* Platform settings and feature flags                                     */
/* ---------------------------------------------------------------------- */

export const featureFlagPatchSchema = z.object({
  enabled: z.boolean(),
  reason: reasonSchema.optional(),
  /** Regulated flags can only be enabled by typing their key. */
  confirmKey: z.string().max(120).optional(),
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

export const settingPatchSchema = z.object({
  value: z.unknown(),
  reason: reasonSchema.optional(),
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

/* ---------------------------------------------------------------------- */
/* Access                                                                  */
/* ---------------------------------------------------------------------- */

export const staffRoleChangeSchema = z
  .object({
    action: z.enum(['grant', 'revoke']),
    userId: z.string().max(64).optional(),
    email: z.string().email().max(254).optional(),
    role: staffRoleSchema,
    reason: reasonSchema,
  })
  .refine((v) => Boolean(v.userId || v.email), 'userId or email is required');

export const staffDirectoryQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const partnerVerifySchema = z.object({
  decision: z.enum(['verify', 'reject']),
  scopeNote: z.string().trim().min(5).max(2000),
  expiresAt: isoDateTimeSchema.nullable().optional(),
});

/* ---------------------------------------------------------------------- */
/* Audit                                                                   */
/* ---------------------------------------------------------------------- */

export const auditListQuerySchema = z.object({
  actorUserId: z.string().max(64).optional(),
  entityType: z.string().max(64).optional(),
  entityId: z.string().max(128).optional(),
  action: z.string().max(120).optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

export const auditEventDtoSchema = z.object({
  id: uuidSchema,
  actorType: z.string(),
  actorUserId: z.string().nullable(),
  actorName: z.string().nullable(),
  organizationId: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  reason: z.string().nullable(),
  correlationId: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type AuditEventDto = z.infer<typeof auditEventDtoSchema>;
