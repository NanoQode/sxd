import { z } from 'zod';
import { evidenceBadgeSchema, isoDateTimeSchema, uuidSchema } from './common';

/**
 * Explorer filters, scenario assumptions, recommendations and saved
 * scenarios. All monetary assumptions are whole naira numbers (scenario
 * arithmetic), never ledger money. "unknown" is a legitimate filter value.
 */

export const objectiveSchema = z.enum([
  'owner_occupation',
  'long_term_rent',
  'development_for_sale',
  'student_housing',
  'commercial',
  'short_stay',
]);
export type Objective = z.infer<typeof objectiveSchema>;

export const metricKeySchema = z.enum([
  'affordability',
  'material_access',
  'net_rental_economics',
  'construction_duration',
  'approval_duration',
  'evidence_backed_demand',
  'infrastructure_site_suitability',
]);
export type MetricKey = z.infer<typeof metricKeySchema>;

export const amenityPreferenceSchema = z.enum(['required', 'preferred', 'unknown_ok', 'any']);

export const explorerFiltersSchema = z.object({
  objective: objectiveSchema.default('long_term_rent'),
  totalBudgetNaira: z.number().positive().max(1e13).nullable().default(null),
  landAreaM2: z.number().positive().max(1e7).nullable().default(null),
  floorAreaM2: z.number().positive().max(1e6).nullable().default(null),
  assetType: z
    .enum([
      'land',
      'residential',
      'commercial',
      'industrial',
      'mixed_use',
      'student_housing',
      'short_stay',
    ])
    .nullable()
    .default(null),
  bedroomsOrUnits: z.number().int().min(0).max(500).nullable().default(null),
  qualitySpecification: z.enum(['basic', 'standard', 'premium']).nullable().default(null),
  targetCompletionMonths: z.number().int().min(1).max(120).nullable().default(null),
  minProjectedNetYieldPercent: z.number().min(0).max(100).nullable().default(null),
  preferredZones: z.array(z.enum(['NC', 'NE', 'NW', 'SE', 'SS', 'SW'])).default([]),
  preferredStateIds: z.array(uuidSchema).default([]),
  riskTolerance: z.enum(['low', 'medium', 'high']).default('medium'),
  evidenceFreshness: z.enum(['fresh_only', 'include_stale']).default('fresh_only'),
  /** Show markets whose evidence is unknown for the selected optional criteria. */
  includeUnknown: z.boolean().default(true),
  power: amenityPreferenceSchema.default('any'),
  water: amenityPreferenceSchema.default('any'),
  internet: amenityPreferenceSchema.default('any'),
  transport: amenityPreferenceSchema.default('any'),
  schools: amenityPreferenceSchema.default('any'),
  hospitals: amenityPreferenceSchema.default('any'),
  floodExposure: z.enum(['any', 'low_only', 'exclude_high', 'unknown_ok']).default('any'),
  soilInvestigation: amenityPreferenceSchema.default('any'),
  serviceTeamAvailability: z
    .enum(['any', 'available_only', 'available_or_on_request'])
    .default('any'),
});
export type ExplorerFilters = z.infer<typeof explorerFiltersSchema>;

export const prioritiesSchema = z.partialRecord(metricKeySchema, z.number().min(0).max(1));
export type Priorities = z.infer<typeof prioritiesSchema>;

const nairaNumber = z.number().finite().min(0).max(1e13);
const fraction = z.number().min(0).max(1);

export const unitGroupSchema = z.object({
  label: z.string().max(60).default('Units'),
  count: z.number().int().min(1).max(1000),
  annualRentPerUnitNaira: nairaNumber,
});

export const opexAssumptionsSchema = z.object({
  managementFeeFraction: fraction.nullable().default(null),
  managementFeeFixedNaira: nairaNumber.nullable().default(null),
  maintenanceNaira: nairaNumber.default(0),
  insuranceNaira: nairaNumber.default(0),
  serviceCostsNaira: nairaNumber.default(0),
  unrecoverableChargesNaira: nairaNumber.default(0),
});

export const taxAssumptionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('fraction_of_noi'), value: fraction }),
  z.object({ kind: z.literal('fixed'), value: nairaNumber }),
]);

export const inputSetSchema = z.object({
  landCostNaira: nairaNumber.nullable().default(null),
  acquisitionCostsNaira: nairaNumber.default(0),
  grossFloorAreaM2: z.number().positive().max(1e6).nullable().default(null),
  buildRateNairaPerM2: nairaNumber.nullable().default(null),
  boqTotalNaira: nairaNumber.nullable().default(null),
  professionalFeesNaira: nairaNumber.default(0),
  approvalsNaira: nairaNumber.default(0),
  utilitiesAndExternalWorksNaira: nairaNumber.default(0),
  contingencyFraction: fraction.default(0),
  financingDuringBuildNaira: nairaNumber.default(0),
  units: z.array(unitGroupSchema).default([]),
  vacancyRate: fraction.default(0),
  collectionLossRate: fraction.default(0),
  otherAnnualIncomeNaira: nairaNumber.default(0),
  opex: opexAssumptionsSchema.prefault({}),
  tax: taxAssumptionSchema.default({ kind: 'none' }),
  capexReserveNaira: nairaNumber.default(0),
  annualDebtServiceNaira: nairaNumber.default(0),
  equityNaira: nairaNumber.nullable().default(null),
  constructionMonths: z.number().int().min(0).max(120).default(12),
  completionDelayMonths: z.number().int().min(0).max(60).default(0),
  shortStay: z
    .object({
      availableNightsPerYear: z.number().int().min(0).max(366),
      occupiedNightFraction: fraction,
      nightlyRateNaira: nairaNumber,
      platformChargeFraction: fraction.default(0),
      cleaningCostPerStayNaira: nairaNumber.default(0),
      averageLengthOfStayNights: z.number().positive().max(366).default(2),
      operatingCostsNaira: nairaNumber.default(0),
    })
    .nullable()
    .default(null),
  discountRate: z.number().min(0).max(1).nullable().default(null),
  exitValueNaira: nairaNumber.nullable().default(null),
  sellingCostsFraction: fraction.default(0),
  holdYears: z.number().int().min(1).max(40).default(10),
});
export type InputSet = z.infer<typeof inputSetSchema>;

export const scenarioAssumptionsSchema = z.object({
  base: inputSetSchema,
  low: inputSetSchema.partial().nullable().default(null),
  high: inputSetSchema.partial().nullable().default(null),
  notes: z.string().max(2000).nullable().default(null),
});
export type ScenarioAssumptions = z.infer<typeof scenarioAssumptionsSchema>;

export const scenarioModeSchema = z.enum(['evidence', 'assumption']);

export const scenarioCreateSchema = z.object({
  name: z.string().min(1).max(120),
  objective: objectiveSchema,
  mode: scenarioModeSchema.default('assumption'),
  filters: explorerFiltersSchema,
  assumptions: scenarioAssumptionsSchema,
  priorities: prioritiesSchema.default({}),
  marketIds: z.array(uuidSchema).max(10).default([]),
});
export type ScenarioCreate = z.infer<typeof scenarioCreateSchema>;

export const scenarioUpdateSchema = scenarioCreateSchema.partial().extend({
  expectedUpdatedAt: isoDateTimeSchema.optional(),
});

export const scenarioDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  objective: objectiveSchema,
  mode: scenarioModeSchema,
  filters: explorerFiltersSchema,
  assumptions: scenarioAssumptionsSchema,
  priorities: prioritiesSchema,
  marketIds: z.array(uuidSchema),
  policyVersion: z.number().int().nullable(),
  ownerUserId: z.string().nullable(),
  organizationId: z.string().nullable(),
  isAnonymous: z.boolean(),
  shareToken: z.string().nullable(),
  shareExpiresAt: isoDateTimeSchema.nullable(),
  convertedServiceRequestId: uuidSchema.nullable(),
  verificationRequestedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type ScenarioDto = z.infer<typeof scenarioDtoSchema>;

export const budgetCeilingSchema = z.object({ amountNaira: nairaNumber });

export const recommendationRequestSchema = z.object({
  objective: objectiveSchema,
  mode: scenarioModeSchema.default('evidence'),
  filters: explorerFiltersSchema.partial().default({}),
  priorities: prioritiesSchema.default({}),
  assumptions: scenarioAssumptionsSchema.nullable().default(null),
  marketIds: z.array(uuidSchema).max(200).optional(),
  rank: z.boolean().default(true),
  budgetCeiling: budgetCeilingSchema.nullable().default(null),
  scenarioId: uuidSchema.optional(),
});
export type RecommendationRequest = z.infer<typeof recommendationRequestSchema>;

export const metricContributionSchema = z.object({
  metric: metricKeySchema,
  weight: z.number(),
  score: z.number().nullable(),
  confidence: z.number().nullable(),
  contribution: z.number().nullable(),
  badge: evidenceBadgeSchema.nullable(),
  evidenceDate: z.string().nullable(),
  unit: z.string().nullable(),
  value: z.number().nullable(),
  geographicScope: z.string().nullable(),
  eligible: z.boolean(),
  reason: z.string().nullable(),
});

export const rankedMarketSchema = z.object({
  marketId: uuidSchema,
  slug: z.string(),
  name: z.string(),
  stateName: z.string(),
  rank: z.number().int().nullable(),
  status: z.enum(['ranked', 'more_local_data_needed', 'scored', 'excluded']),
  fit: z.number().nullable(),
  assumptionFit: z.number().nullable(),
  coverage: z.number().nullable(),
  confidence: z.number().nullable(),
  missing: z.array(z.string()),
  exclusionReason: z.string().nullable(),
  budgetAssessable: z.boolean().nullable(),
  riskAssessment: z.object({ flood: z.string(), title: z.string() }),
  topContributors: z.array(metricContributionSchema),
  metrics: z.array(metricContributionSchema),
  biddingWindowDays: z.number().nullable(),
  whyMatches: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  lastReviewedAt: isoDateTimeSchema.nullable(),
});
export type RankedMarketDto = z.infer<typeof rankedMarketSchema>;

export const recommendationResponseSchema = z.object({
  policyVersion: z.number().int(),
  mode: scenarioModeSchema,
  objective: objectiveSchema,
  rankingEnabled: z.boolean(),
  rankingDisabledReason: z.string().nullable(),
  effectiveWeights: z.partialRecord(metricKeySchema, z.number()),
  organic: z.array(rankedMarketSchema),
  sponsored: z.array(rankedMarketSchema),
  excluded: z.array(rankedMarketSchema),
  policyErrors: z.array(z.object({ metric: z.string().nullable(), message: z.string() })),
  snapshotId: uuidSchema.nullable(),
  generatedAt: isoDateTimeSchema,
  disclaimer: z.string(),
});
export type RecommendationResponse = z.infer<typeof recommendationResponseSchema>;

export const comparisonRequestSchema = z.object({
  marketIds: z.array(uuidSchema).min(2).max(4),
  objective: objectiveSchema,
  mode: scenarioModeSchema.default('evidence'),
  priorities: prioritiesSchema.default({}),
  assumptions: scenarioAssumptionsSchema.nullable().default(null),
  scenarioId: uuidSchema.optional(),
});

export const comparisonCellSchema = z.object({
  marketId: uuidSchema,
  value: z.number().nullable(),
  unit: z.string().nullable(),
  badge: evidenceBadgeSchema,
  evidenceDate: z.string().nullable(),
  confidence: z.number().nullable(),
  geographicScope: z.string().nullable(),
  label: z.string().nullable(),
});

export const comparisonResponseSchema = z.object({
  policyVersion: z.number().int(),
  markets: z.array(
    z.object({
      marketId: uuidSchema,
      slug: z.string(),
      name: z.string(),
      stateName: z.string(),
      parentMarketId: uuidSchema.nullable(),
    }),
  ),
  rows: z.array(
    z.object({ metric: z.string(), label: z.string(), cells: z.array(comparisonCellSchema) }),
  ),
  overlapWarnings: z.array(z.object({ marketIds: z.array(uuidSchema), message: z.string() })),
  calculators: z
    .array(
      z.object({
        marketId: uuidSchema,
        set: z.enum(['low', 'base', 'high']),
        result: z.unknown(),
      }),
    )
    .default([]),
  generatedAt: isoDateTimeSchema,
  reportTitle: z.string(),
});
export type ComparisonResponse = z.infer<typeof comparisonResponseSchema>;

/** POST /api/v1/calculators/run: pure calculation without persistence. */
export const calculatorRunRequestSchema = z.object({
  assumptions: scenarioAssumptionsSchema,
  objective: objectiveSchema.default('long_term_rent'),
  sensitivity: z
    .object({
      vacancy: z.array(fraction).max(9).default([]),
      rents: z.array(z.number().min(0).max(5)).max(9).default([]),
      costs: z.array(z.number().min(0).max(5)).max(9).default([]),
      interest: z.array(z.number().min(0).max(1)).max(9).default([]),
      completionDelayMonths: z.array(z.number().int().min(0).max(60)).max(9).default([]),
    })
    .prefault({}),
});
export type CalculatorRunRequest = z.infer<typeof calculatorRunRequestSchema>;

/* ---------------------------------------------------------------------- */
/* Read-model additions: calculator responses, scenario pages, sharing,    */
/* snapshots, reports and verification requests                           */
/* ---------------------------------------------------------------------- */

/**
 * Result envelope shared by every calculator figure: `ok: false` carries the
 * reason (and the inputs still missing) instead of a defaulted number.
 */
export const calculatorResultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), reason: z.string(), missing: z.array(z.string()).optional() }),
]);
export type CalculatorResultDto = z.infer<typeof calculatorResultSchema>;

export const calculatorSetResultSchema = z.object({
  set: z.enum(['low', 'base', 'high']),
  inputs: inputSetSchema,
  /** Which economics model the objective selects: annual leases or short stays, never mixed. */
  economicsKind: z.enum(['long_let', 'short_stay']),
  developmentCost: calculatorResultSchema,
  longLet: calculatorResultSchema.nullable(),
  shortStay: calculatorResultSchema.nullable(),
  phasing: calculatorResultSchema,
  npv: calculatorResultSchema,
  irr: calculatorResultSchema,
  /** Derived figures the ranking adapter uses in assumption mode (null when not derivable). */
  derived: z.object({
    totalDevelopmentCostNaira: z.number().nullable(),
    costPerM2Naira: z.number().nullable(),
    netYieldPercent: z.number().nullable(),
    constructionDurationDays: z.number().nullable(),
  }),
  notes: z.array(z.string()),
});
export type CalculatorSetResultDto = z.infer<typeof calculatorSetResultSchema>;

export const calculatorRunResponseSchema = z.object({
  objective: objectiveSchema,
  sets: z.object({
    base: calculatorSetResultSchema,
    low: calculatorSetResultSchema.nullable(),
    high: calculatorSetResultSchema.nullable(),
  }),
  sensitivity: calculatorResultSchema,
  scenarioSets: z.object({
    low: calculatorResultSchema,
    base: calculatorResultSchema,
    high: calculatorResultSchema,
  }),
  generatedAt: isoDateTimeSchema,
  disclaimer: z.string(),
});
export type CalculatorRunResponse = z.infer<typeof calculatorRunResponseSchema>;

export const scenarioListQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const scenarioPageSchema = z.object({
  items: z.array(scenarioDtoSchema),
  nextCursor: z.string().nullable(),
});
export type ScenarioPage = z.infer<typeof scenarioPageSchema>;

export const scenarioShareRequestSchema = z.object({
  expiresInDays: z.number().int().min(1).max(90).default(30),
});

export const scenarioShareResponseSchema = z.object({
  scenarioId: uuidSchema,
  shareToken: z.string(),
  shareExpiresAt: isoDateTimeSchema,
  sharePath: z.string(),
});
export type ScenarioShareResponse = z.infer<typeof scenarioShareResponseSchema>;

export const scenarioSnapshotResponseSchema = z.object({
  snapshotId: uuidSchema,
  scenarioId: uuidSchema,
  policyVersion: z.number().int(),
  generatedAt: isoDateTimeSchema,
  inputsHash: z.string(),
  policyHash: z.string(),
  sourceVersions: z.record(z.string(), z.string()),
  recommendation: recommendationResponseSchema,
});
export type ScenarioSnapshotResponse = z.infer<typeof scenarioSnapshotResponseSchema>;

export const sharedScenarioResponseSchema = z.object({
  scenario: scenarioDtoSchema,
  snapshot: z
    .object({
      id: uuidSchema,
      policyVersion: z.number().int(),
      generatedAt: isoDateTimeSchema,
      recommendation: recommendationResponseSchema,
    })
    .nullable(),
  readOnly: z.literal(true),
});
export type SharedScenarioResponse = z.infer<typeof sharedScenarioResponseSchema>;

export const comparisonReportSchema = z.object({
  reportId: uuidSchema,
  title: z.string(),
  generatedAt: isoDateTimeSchema,
  scenario: scenarioDtoSchema,
  snapshot: z.object({
    id: uuidSchema,
    policyVersion: z.number().int(),
    generatedAt: isoDateTimeSchema,
    inputsHash: z.string(),
    policyHash: z.string(),
    sourceVersions: z.record(z.string(), z.string()),
  }),
  markets: z.array(rankedMarketSchema),
  rows: z.array(
    z.object({ metric: z.string(), label: z.string(), cells: z.array(comparisonCellSchema) }),
  ),
  overlapWarnings: z.array(z.object({ marketIds: z.array(uuidSchema), message: z.string() })),
  disclaimer: z.string(),
});
export type ComparisonReportDto = z.infer<typeof comparisonReportSchema>;

/** POST /api/v1/scenarios/:id/request-verification: contact details for a local verification lead. */
export const scenarioVerificationRequestSchema = z.object({
  contactName: z.string().trim().min(2).max(120),
  email: z.email().max(254),
  phoneE164: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, 'E.164 phone number, e.g. +2348012345678')
    .nullable()
    .optional(),
  countryOfResidence: z.string().length(2).nullable().optional(),
  timeZone: z.string().min(1).max(64).nullable().optional(),
  message: z.string().trim().max(4000).nullable().optional(),
  marketingConsent: z.boolean().default(false),
  consentPolicyVersion: z.string().max(32).default('2026-09'),
  website: z.string().max(0).optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
});
export type ScenarioVerificationRequest = z.infer<typeof scenarioVerificationRequestSchema>;

export const scenarioVerificationResponseSchema = z.object({
  scenarioId: uuidSchema,
  leadId: uuidSchema,
  leadStatus: z.string(),
  verificationRequestedAt: isoDateTimeSchema,
});
export type ScenarioVerificationResponse = z.infer<typeof scenarioVerificationResponseSchema>;
