import { sql } from 'drizzle-orm';
import {
  boolean,
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
  geometryPoint,
  id,
  jsonObject,
  kobo,
  timestamps,
  tstz,
  version,
} from './_common';
import { organization, user } from './auth';
import { markets, neighborhoods, publicationStateEnum, sources, states } from './geography';

export const geographyLevelEnum = pgEnum('geography_level', [
  'country',
  'state_or_fct',
  'city',
  'neighborhood',
  'site',
]);

export const statisticTypeEnum = pgEnum('statistic_type', [
  'median',
  'mean',
  'min',
  'max',
  'range',
  'count',
  'categorical',
  'quote',
  'single_observation',
]);

export const observationReviewStatusEnum = pgEnum('observation_review_status', [
  'source_read_pending_business_review',
  'verified',
  'disputed',
  'rejected',
  'superseded',
  'stale',
]);

export const numericRepresentationEnum = pgEnum('numeric_representation', [
  'whole_naira_not_kobo',
  'kobo',
  'percent',
  'days',
  'count',
  'text',
  'other',
]);

export const materialEnum = pgEnum('material', [
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

export const facilityEvidenceStatusEnum = pgEnum('facility_evidence_status', [
  'published_facility_location',
  'unverified_lead',
  'verified_supplier',
]);

export const stockStatusEnum = pgEnum('stock_status', [
  'unknown',
  'in_stock',
  'limited',
  'out_of_stock',
]);

export const supplierRelationEnum = pgEnum('supplier_relation', [
  'editorial_lead',
  'verified_delivery',
  'dealer_appointed',
]);

export const rankingPolicyStatusEnum = pgEnum('ranking_policy_status', [
  'draft',
  'active',
  'retired',
]);

export const scenarioModeEnum = pgEnum('scenario_mode', ['evidence', 'assumption']);

export const researchTaskStatusEnum = pgEnum('research_task_status', [
  'open',
  'in_progress',
  'in_review',
  'done',
  'blocked',
]);

export const importStatusEnum = pgEnum('import_status', [
  'previewed',
  'applied',
  'failed',
  'cancelled',
]);

/** Immutable source observations. Status changes are recorded in reviews. */
export const observations = pgTable(
  'observations',
  {
    id: id(),
    slug: text().unique(),
    sourceId: uuid()
      .notNull()
      .references(() => sources.id),
    sourceUrl: text(),
    metric: text().notNull(),
    valueNumeric: numeric({ precision: 20, scale: 4 }),
    valueLow: numeric({ precision: 20, scale: 4 }),
    valueHigh: numeric({ precision: 20, scale: 4 }),
    valueText: text(),
    unit: text().notNull(),
    currency: text(),
    numericRepresentation: numericRepresentationEnum().notNull().default('other'),
    geographyLevel: geographyLevelEnum().notNull(),
    geographyLabel: text().notNull(),
    stateId: uuid().references(() => states.id),
    marketId: uuid().references(() => markets.id),
    neighborhoodId: uuid().references(() => neighborhoods.id),
    propertyCohort: text().notNull(),
    statistic: statisticTypeEnum().notNull(),
    observationPeriodStart: date({ mode: 'string' }),
    observationPeriodEnd: date({ mode: 'string' }),
    periodCompleteAtRetrieval: boolean(),
    sourceUpdatedAt: date({ mode: 'string' }),
    retrievedAt: date({ mode: 'string' }).notNull(),
    sampleSize: integer(),
    collectionMethod: text(),
    licenseNote: text(),
    validUntil: date({ mode: 'string' }),
    rankEligible: boolean().notNull().default(false),
    reasonNotRankEligible: text(),
    evidenceFileId: uuid(),
    createdBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('observations_market_idx').on(t.marketId, t.metric),
    index('observations_state_idx').on(t.stateId, t.metric),
    index('observations_metric_idx').on(t.metric),
  ],
);

/** Versioned editorial interpretation and review state for an observation. */
export const observationInterpretations = pgTable(
  'observation_interpretations',
  {
    id: id(),
    observationId: uuid()
      .notNull()
      .references(() => observations.id),
    version: integer().notNull(),
    isCurrent: boolean().notNull().default(true),
    reviewStatus: observationReviewStatusEnum()
      .notNull()
      .default('source_read_pending_business_review'),
    publicationState: publicationStateEnum().notNull().default('draft'),
    rankEligible: boolean().notNull().default(false),
    reasonNotRankEligible: text(),
    editorialNote: text(),
    cohortMapping: text(),
    appliesToMarketId: uuid().references(() => markets.id),
    freshnessOverrideUntil: date({ mode: 'string' }),
    reviewerId: text().references(() => user.id),
    publishedBy: text().references(() => user.id),
    publishedAt: tstz(),
    createdBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('observation_interpretations_unique').on(t.observationId, t.version),
    index('observation_interpretations_current_idx')
      .on(t.observationId)
      .where(sql`${t.isCurrent}`),
  ],
);

export const observationReviews = pgTable(
  'observation_reviews',
  {
    id: id(),
    observationId: uuid()
      .notNull()
      .references(() => observations.id),
    interpretationId: uuid().references(() => observationInterpretations.id),
    reviewerId: text()
      .notNull()
      .references(() => user.id),
    decision: text().notNull(),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [index('observation_reviews_obs_idx').on(t.observationId)],
);

export const supplyFacilities = pgTable(
  'supply_facilities',
  {
    id: id(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    operator: text(),
    stateId: uuid().references(() => states.id),
    material: materialEnum().notNull(),
    sourceId: uuid().references(() => sources.id),
    evidenceStatus: facilityEvidenceStatusEnum().notNull().default('unverified_lead'),
    location: geometryPoint(),
    deliveryCoverageVerified: boolean().notNull().default(false),
    stockStatus: stockStatusEnum().notNull().default('unknown'),
    rankEligible: boolean().notNull().default(false),
    contactPermission: boolean().notNull().default(false),
    notes: text(),
    importFingerprint: text(),
    humanEditedAt: tstz(),
    archivedAt: tstz(),
    version: version(),
    ...timestamps(),
  },
  (t) => [index('supply_facilities_state_idx').on(t.stateId, t.material)],
);

export const supplierCoverage = pgTable(
  'supplier_coverage',
  {
    id: id(),
    facilityId: uuid()
      .notNull()
      .references(() => supplyFacilities.id),
    marketId: uuid()
      .notNull()
      .references(() => markets.id),
    relation: supplierRelationEnum().notNull().default('editorial_lead'),
    verifiedAt: tstz(),
    verifiedBy: text().references(() => user.id),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('supplier_coverage_unique').on(t.facilityId, t.marketId)],
);

export const supplierQuotes = pgTable(
  'supplier_quotes',
  {
    id: id(),
    facilityId: uuid().references(() => supplyFacilities.id),
    supplierName: text(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id),
    material: materialEnum().notNull(),
    specification: text().notNull(),
    unit: text().notNull(),
    quantity: numeric({ precision: 14, scale: 3 }),
    unitPriceKobo: kobo(),
    deliveryCostKobo: kobo(),
    taxesKobo: kobo(),
    unloadingKobo: kobo(),
    leadTimeDays: integer(),
    routeConditions: text(),
    quotedAt: date({ mode: 'string' }).notNull(),
    validUntil: date({ mode: 'string' }),
    contactPermission: boolean().notNull().default(false),
    evidenceFileId: uuid(),
    reviewStatus: observationReviewStatusEnum()
      .notNull()
      .default('source_read_pending_business_review'),
    rankEligible: boolean().notNull().default(false),
    createdBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [index('supplier_quotes_market_idx').on(t.marketId, t.material)],
);

export type RankingWeights = Record<string, number>;
export interface MetricBound {
  metric: string;
  direction: 'higher_is_better' | 'lower_is_better';
  unit: string;
  low: number;
  high: number;
  cohort?: string;
  note?: string;
}

export const rankingPolicies = pgTable('ranking_policies', {
  id: id(),
  version: integer().notNull().unique(),
  name: text().notNull(),
  status: rankingPolicyStatusEnum().notNull().default('draft'),
  weights: jsonObject<RankingWeights>().notNull(),
  metricBounds: jsonObject<MetricBound[]>().notNull(),
  confidenceRubric: jsonb().notNull(),
  coverageThreshold: numeric({ precision: 5, scale: 4 }).notNull().default('0.7000'),
  minComparables: integer().notNull().default(10),
  hardConstraints: jsonb(),
  notes: text(),
  createdBy: text().references(() => user.id),
  approvedBy: text().references(() => user.id),
  activatedAt: tstz(),
  retiredAt: tstz(),
  createdAt: createdAt(),
});

export const freshnessPolicies = pgTable('freshness_policies', {
  id: id(),
  dataType: text().notNull().unique(),
  maxAgeDays: integer(),
  respectSourceValidity: boolean().notNull().default(true),
  note: text(),
  updatedBy: text().references(() => user.id),
  ...timestamps(),
});

export const dataPolicySettings = pgTable('data_policy_settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  description: text(),
  updatedBy: text().references(() => user.id),
  ...timestamps(),
});

export const scenarios = pgTable(
  'scenarios',
  {
    id: id(),
    ownerUserId: text().references(() => user.id, { onDelete: 'set null' }),
    organizationId: text().references(() => organization.id),
    anonymousToken: text(),
    name: text().notNull(),
    objective: text().notNull(),
    mode: scenarioModeEnum().notNull().default('assumption'),
    filters: jsonb().notNull(),
    assumptions: jsonb().notNull(),
    priorities: jsonb().notNull(),
    marketIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    policyVersion: integer(),
    shareToken: text().unique(),
    shareExpiresAt: tstz(),
    convertedServiceRequestId: uuid(),
    verificationRequestedAt: tstz(),
    expiresAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index('scenarios_owner_idx').on(t.ownerUserId),
    index('scenarios_anon_idx').on(t.anonymousToken),
  ],
);

export const recommendationSnapshots = pgTable(
  'recommendation_snapshots',
  {
    id: id(),
    scenarioId: uuid()
      .notNull()
      .references(() => scenarios.id, { onDelete: 'cascade' }),
    policyVersion: integer().notNull(),
    inputs: jsonb().notNull(),
    sourceVersions: jsonb().notNull(),
    results: jsonb().notNull(),
    generatedBy: text().references(() => user.id),
    generatedAt: createdAt(),
  },
  (t) => [index('recommendation_snapshots_scenario_idx').on(t.scenarioId)],
);

export const comparisonReports = pgTable('comparison_reports', {
  id: id(),
  scenarioId: uuid()
    .notNull()
    .references(() => scenarios.id, { onDelete: 'cascade' }),
  snapshotId: uuid()
    .notNull()
    .references(() => recommendationSnapshots.id),
  fileId: uuid(),
  title: text().notNull(),
  generatedAt: createdAt(),
  shareToken: text().unique(),
  expiresAt: tstz(),
});

export const marketImports = pgTable('market_imports', {
  id: id(),
  uploadedBy: text().references(() => user.id),
  fileName: text().notNull(),
  format: text().notNull(),
  fileId: uuid(),
  status: importStatusEnum().notNull().default('previewed'),
  summary: jsonb().notNull(),
  rowErrors: jsonb()
    .notNull()
    .default(sql`'[]'::jsonb`),
  conflicts: jsonb()
    .notNull()
    .default(sql`'[]'::jsonb`),
  appliedAt: tstz(),
  appliedBy: text().references(() => user.id),
  createdAt: createdAt(),
});

export const researchTasks = pgTable(
  'research_tasks',
  {
    id: id(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id),
    title: text().notNull(),
    category: text().notNull(),
    status: researchTaskStatusEnum().notNull().default('open'),
    priority: integer().notNull().default(3),
    assigneeUserId: text().references(() => user.id),
    reviewerUserId: text().references(() => user.id),
    budgetKobo: kobo(),
    dueDate: date({ mode: 'string' }),
    evidenceRightsNote: text(),
    targetCount: integer(),
    completedCount: integer().notNull().default(0),
    notes: text(),
    completedAt: tstz(),
    ...timestamps(),
  },
  (t) => [index('research_tasks_market_idx').on(t.marketId, t.status)],
);
