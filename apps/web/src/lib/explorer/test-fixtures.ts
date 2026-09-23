import type {
  MarketDetailDto,
  MarketSummaryDto,
  ObservationDto,
  RankedMarketDto,
  RecommendationResponse,
} from '@simplexd/contracts';

/** Deterministic fixtures for explorer unit tests. Never used at runtime. */

export const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let counter = 1;

export function market(
  overrides: Partial<MarketSummaryDto> & Pick<MarketSummaryDto, 'slug' | 'name'>,
): MarketSummaryDto {
  const n = counter++;
  return {
    id: uuid(n),
    aliases: [],
    stateId: uuid(1000 + n),
    stateName: 'Lagos',
    isFederalCapital: false,
    geopoliticalZone: 'SW',
    displayOrder: n,
    location: { lon: 3.39 + n * 0.01, lat: 6.45 + n * 0.01 },
    coordinateAccuracy: 'city_reference_point_not_parcel_or_boundary',
    parentMarketId: null,
    overlapNote: null,
    serviceAvailability: 'pending_operations_confirmation',
    publicationState: 'published',
    recommendationStatus: 'insufficient_local_evidence',
    evidence: {
      localObservations: 0,
      regionalContextObservations: 0,
      supplierLeads: 0,
      supplierQuotes: 0,
      openResearchTasks: 3,
      lastReviewedAt: null,
      lastResearchedAt: '2026-09-22',
      freshness: 'unknown',
      badges: [],
    },
    metrics: {},
    version: 1,
    ...overrides,
  };
}

export function ranked(
  overrides: Partial<RankedMarketDto> & Pick<RankedMarketDto, 'slug' | 'name' | 'marketId'>,
): RankedMarketDto {
  return {
    stateName: 'Lagos',
    rank: null,
    status: 'more_local_data_needed',
    fit: null,
    assumptionFit: null,
    coverage: 0,
    confidence: null,
    missing: ['local_cost_evidence', 'local_rent_evidence'],
    exclusionReason: null,
    budgetAssessable: null,
    riskAssessment: { flood: 'unable_to_assess', title: 'unable_to_assess' },
    topContributors: [],
    metrics: [],
    biddingWindowDays: null,
    whyMatches: [],
    missingEvidence: ['Local cost evidence', 'Local rent evidence'],
    lastReviewedAt: null,
    ...overrides,
  };
}

export function recommendation(
  overrides: Partial<RecommendationResponse> = {},
): RecommendationResponse {
  return {
    policyVersion: 1,
    mode: 'evidence',
    objective: 'long_term_rent',
    rankingEnabled: true,
    rankingDisabledReason: null,
    effectiveWeights: {},
    organic: [],
    sponsored: [],
    excluded: [],
    policyErrors: [],
    snapshotId: null,
    generatedAt: '2026-09-23T10:00:00.000Z',
    disclaimer: 'Deterministic policy ranking; not investment advice.',
    ...overrides,
  };
}

export function observation(overrides: Partial<ObservationDto> = {}): ObservationDto {
  return {
    id: uuid(500),
    slug: 'npc-rent-lagos',
    metric: 'median_annual_asking_rent',
    value: 14_000_000,
    valueLow: null,
    valueHigh: null,
    valueText: null,
    unit: 'NGN/year',
    currency: 'NGN',
    numericRepresentation: 'whole_naira_not_kobo',
    statistic: 'median',
    propertyCohort: 'all_reported_property_types_mixed',
    geographyLevel: 'state_or_fct',
    geographyLabel: 'Lagos',
    marketId: null,
    stateId: uuid(1001),
    observationPeriodStart: '2026-07-01',
    observationPeriodEnd: '2026-09-30',
    periodCompleteAtRetrieval: false,
    sourceUpdatedAt: '2026-09-21',
    retrievedAt: '2026-09-22',
    validUntil: null,
    sampleSize: 34_389,
    collectionMethod: 'published report read',
    source: {
      id: uuid(600),
      slug: 'npc-q3-2026',
      title: 'Nigeria Property Centre Q3 2026 asking-price report',
      url: 'https://nigeriapropertycentre.com/market-reports/q3-2026',
      licenseNote: null,
      retrievedAt: '2026-09-22',
    },
    badge: 'regional_context',
    freshness: 'fresh',
    reviewStatus: 'source_read_pending_business_review',
    publicationState: 'published',
    rankEligible: false,
    reasonNotRankEligible: 'Mixed property types; contextual observation only.',
    editorialNote: null,
    interpretationVersion: 1,
    ...overrides,
  };
}

export function marketDetail(
  overrides: Partial<MarketDetailDto> & Pick<MarketDetailDto, 'slug' | 'name'>,
): MarketDetailDto {
  const summary = market({ slug: overrides.slug, name: overrides.name });
  return {
    ...summary,
    selectionBasis: 'State capital',
    coordinateSource: null,
    sourceCityName: overrides.name,
    profileMarkdown: null,
    supplyMappingMethod: null,
    researchTasks: [],
    neighborhoods: [],
    localObservations: [],
    regionalContextObservations: [],
    supplierLeads: [],
    supplierQuotes: [],
    serviceCoverage: [],
    flags: [],
    missingEvidence: [],
    timelineTemplate: null,
    lastReviewedAt: null,
    publishedAt: null,
    importedAt: null,
    humanEditedAt: null,
    ...overrides,
  };
}
