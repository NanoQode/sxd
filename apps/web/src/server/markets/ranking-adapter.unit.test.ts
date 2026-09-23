import { describe, expect, it } from 'vitest';
import { explorerFiltersSchema, type ScenarioAssumptions } from '@simplexd/contracts';
import { DEFAULT_FRESHNESS_DAYS, DEFAULT_RANKING_POLICY } from '@simplexd/domain/ranking';
import { deriveEvidence } from './market-metrics';
import type { PolicyContext } from './policy';
import {
  deriveAssumptionFigures,
  explorerExclusion,
  flagsFor,
  runRankingAdapter,
} from './ranking-adapter';
import type { MarketBundle, ObservationRecord } from './types';

const asOf = new Date('2026-09-23T12:00:00.000Z');

const policy: PolicyContext = {
  asOf,
  policies: new Map([
    ['rent_observation', { maxAgeDays: 90, respectSourceValidity: true }],
    ['sale_observation', { maxAgeDays: 90, respectSourceValidity: true }],
    ['build_rate', { maxAgeDays: 90, respectSourceValidity: true }],
  ]),
  activeRankingPolicyVersion: 1,
  settings: { defaultFinancialRankingEnabled: false, coverageThreshold: 0.7 },
  policy: DEFAULT_RANKING_POLICY,
  policyRowId: 'policy-row',
  freshnessDays: DEFAULT_FRESHNESS_DAYS,
  coverageThreshold: 0.7,
};

function bundle(
  overrides: Partial<MarketBundle['market']> & { id: string },
  local: ObservationRecord[] = [],
): MarketBundle {
  return {
    market: {
      slug: `ng-${overrides.id}`,
      name: overrides.id.toUpperCase(),
      aliases: [],
      countryCode: 'NG',
      stateId: 'state-lagos',
      geopoliticalZone: 'SW',
      displayOrder: 1,
      selectionBasis: null,
      location: { lon: 3.4, lat: 6.5 },
      coordinateSourceId: null,
      coordinateAccuracy: null,
      sourceCityName: null,
      parentMarketId: null,
      overlapNote: null,
      serviceAvailability: 'pending_operations_confirmation',
      publicationState: 'published',
      profileMarkdown: null,
      supplyMappingMethod: null,
      recommendationStatus: 'insufficient_local_evidence',
      researchTasks: null,
      lastResearchedAt: null,
      lastReviewedAt: null,
      reviewedBy: null,
      publishedAt: null,
      publishedBy: null,
      archivedAt: null,
      mergedIntoMarketId: null,
      importFingerprint: null,
      importedAt: null,
      humanEditedAt: null,
      version: 1,
      createdBy: null,
      updatedBy: null,
      createdAt: asOf,
      updatedAt: asOf,
      ...overrides,
    },
    state: {
      id: 'state-lagos',
      countryCode: 'NG',
      name: 'Lagos',
      code: null,
      geopoliticalZone: 'SW',
      isFederalCapital: false,
      createdAt: asOf,
    },
    local,
    regional: [],
    leads: [],
    quotes: [],
    tasks: [],
    flags: [],
  };
}

function localObservation(
  metric: string,
  value: number,
  unit: string,
  rankEligible = true,
): ObservationRecord {
  return {
    observation: {
      id: `obs-${metric}`,
      slug: null,
      sourceId: 'src',
      sourceUrl: null,
      metric,
      valueNumeric: String(value),
      valueLow: null,
      valueHigh: null,
      valueText: null,
      unit,
      currency: 'NGN',
      numericRepresentation: 'other',
      geographyLevel: 'city',
      geographyLabel: 'Lagos',
      stateId: null,
      marketId: 'lagos',
      neighborhoodId: null,
      propertyCohort: 'residential',
      statistic: 'median',
      observationPeriodStart: null,
      observationPeriodEnd: '2026-09-15',
      periodCompleteAtRetrieval: true,
      sourceUpdatedAt: null,
      retrievedAt: '2026-09-16',
      sampleSize: 12,
      collectionMethod: 'first_party_survey',
      licenseNote: null,
      validUntil: null,
      rankEligible,
      reasonNotRankEligible: null,
      evidenceFileId: null,
      createdBy: null,
      createdAt: asOf,
    },
    interpretation: {
      id: `int-${metric}`,
      observationId: `obs-${metric}`,
      version: 2,
      isCurrent: true,
      reviewStatus: 'verified',
      publicationState: 'published',
      rankEligible,
      reasonNotRankEligible: null,
      editorialNote: null,
      cohortMapping: null,
      appliesToMarketId: null,
      freshnessOverrideUntil: null,
      reviewerId: null,
      publishedBy: null,
      publishedAt: asOf,
      createdBy: null,
      createdAt: asOf,
    },
    source: {
      id: 'src',
      slug: 'first-party',
      title: 'SimplexD survey',
      publisher: null,
      url: null,
      dataUrl: null,
      licenseNote: null,
      licenseRights: 'first_party',
      useNote: null,
      retrievedAt: null,
      createdBy: null,
      createdAt: asOf,
      updatedAt: asOf,
    },
  };
}

const assumptions: ScenarioAssumptions = {
  base: {
    landCostNaira: 20_000_000,
    acquisitionCostsNaira: 0,
    grossFloorAreaM2: 400,
    buildRateNairaPerM2: 200_000,
    boqTotalNaira: null,
    professionalFeesNaira: 0,
    approvalsNaira: 0,
    utilitiesAndExternalWorksNaira: 0,
    contingencyFraction: 0,
    financingDuringBuildNaira: 0,
    units: [{ label: 'flats', count: 2, annualRentPerUnitNaira: 3_000_000 }],
    vacancyRate: 0.1,
    collectionLossRate: 0,
    otherAnnualIncomeNaira: 0,
    opex: {
      managementFeeFraction: null,
      managementFeeFixedNaira: null,
      maintenanceNaira: 1_200_000,
      insuranceNaira: 0,
      serviceCostsNaira: 0,
      unrecoverableChargesNaira: 0,
    },
    tax: { kind: 'none' },
    capexReserveNaira: 0,
    annualDebtServiceNaira: 0,
    equityNaira: null,
    constructionMonths: 12,
    completionDelayMonths: 3,
    shortStay: null,
    discountRate: null,
    exitValueNaira: null,
    sellingCostsFraction: 0,
    holdYears: 10,
  },
  low: null,
  high: null,
  notes: null,
};

describe('deriveAssumptionFigures', () => {
  it('derives cost per m², net yield and construction days from the base assumptions', () => {
    const figures = deriveAssumptionFigures(assumptions, 'long_term_rent', asOf);
    expect(figures.inputs.affordability).toMatchObject({
      value: 250_000,
      unit: 'NGN/m2',
      kind: 'model_estimate',
    });
    expect(figures.inputs.net_rental_economics?.value).toBeCloseTo(4.2, 10);
    expect(figures.inputs.construction_duration).toMatchObject({
      value: 450,
      unit: 'days',
      kind: 'user_assumption',
    });
    expect(figures.totalCostNaira).toBe(100_000_000);
  });

  it('leaves affordability absent for a zero-cost scenario instead of a perfect score', () => {
    const zero = {
      ...assumptions,
      base: { ...assumptions.base, landCostNaira: 0, buildRateNairaPerM2: null },
    };
    const figures = deriveAssumptionFigures(zero, 'long_term_rent', asOf);
    expect(figures.inputs.affordability).toBeUndefined();
    expect(figures.inputs.net_rental_economics).toBeUndefined();
    expect(figures.totalCostNaira).toBeNull();
  });
});

describe('deriveEvidence', () => {
  it('maps rank-eligible local observations onto ranking metrics and combines land and build costs', () => {
    const local = [
      localObservation('land_price_ngn_per_m2', 50_000, 'NGN/m2'),
      localObservation('build_rate_ngn_per_m2', 200_000, 'NGN/m2'),
      localObservation('approval_duration_days', 60, 'days'),
      localObservation('median_annual_asking_rent', 5_000_000, 'NGN/year', false),
    ];
    const derived = deriveEvidence(local, {
      asOf,
      policies: policy.policies,
      landAreaM2: 800,
      floorAreaM2: 400,
    });
    // 50k x 800 + 200k x 400 = 120m over 400 m2 = 300,000 NGN/m2
    expect(derived.inputs.affordability).toMatchObject({
      value: 300_000,
      unit: 'NGN/m2',
      kind: 'verified_operational_record',
    });
    expect(derived.totalCostEvidence).toMatchObject({ value: 120_000_000, unit: 'NGN' });
    expect(derived.inputs.approval_duration).toMatchObject({
      value: 60,
      sourceVersion: 'obs:obs-approval_duration_days@v2',
    });
    expect(derived.hasLocalCostEvidence).toBe(true);
    // The mixed-stock rent median is not rank-eligible, so it never becomes rental evidence.
    expect(derived.hasLocalRentEvidence).toBe(false);
    expect(derived.metrics['land_price_ngn_per_m2']?.value).toBe(50_000);
    expect(derived.metrics['net_rental_economics']).toBeNull();
    const withoutAreas = deriveEvidence(local, { asOf, policies: policy.policies });
    expect(withoutAreas.inputs.affordability).toBeUndefined();
    expect(withoutAreas.totalCostEvidence).toBeNull();
  });

  it('ignores stale and unpublished rows for ranking inputs but still reports the stale badge', () => {
    const stale = localObservation('approval_duration_days', 60, 'days');
    stale.observation.observationPeriodEnd = '2025-01-01';
    const derived = deriveEvidence([stale], { asOf, policies: policy.policies });
    expect(derived.inputs.approval_duration).toBeUndefined();
    expect(derived.metrics['approval_duration']?.badge).toBe('stale');
    const included = deriveEvidence([stale], {
      asOf,
      policies: policy.policies,
      includeStale: true,
    });
    expect(included.inputs.approval_duration?.kind).toBe('verified_operational_record');
  });
});

describe('explorer constraints', () => {
  const filters = (patch: Record<string, unknown>) => explorerFiltersSchema.parse(patch);
  const empty = deriveEvidence([], { asOf, policies: policy.policies });
  const flags = flagsFor(bundle({ id: 'lagos' }), asOf);

  it('keeps unknown flood status when unknown is included and excludes it otherwise', () => {
    expect(flags).toEqual({ floodStatus: 'unknown', titleStatus: 'unknown' });
    expect(
      explorerExclusion(
        bundle({ id: 'lagos' }),
        filters({ floodExposure: 'low_only' }),
        flags,
        empty,
        null,
        null,
      ),
    ).toBeNull();
    expect(
      explorerExclusion(
        bundle({ id: 'lagos' }),
        filters({ floodExposure: 'low_only', includeUnknown: false }),
        flags,
        empty,
        null,
        null,
      ),
    ).toMatchObject({ reason: 'flood_exposure' });
  });

  it('applies zones, states and service availability as hard constraints', () => {
    expect(
      explorerExclusion(
        bundle({ id: 'lagos' }),
        filters({ preferredZones: ['NC'] }),
        flags,
        empty,
        null,
        null,
      ),
    ).toMatchObject({
      reason: 'outside_preferred_zones',
    });
    expect(
      explorerExclusion(
        bundle({ id: 'lagos' }),
        filters({ preferredStateIds: ['00000000-0000-4000-8000-000000000000'] }),
        flags,
        empty,
        null,
        null,
      ),
    ).toMatchObject({ reason: 'outside_preferred_states' });
    expect(
      explorerExclusion(
        bundle({ id: 'lagos' }),
        filters({ serviceTeamAvailability: 'available_only' }),
        flags,
        empty,
        null,
        null,
      ),
    ).toMatchObject({ reason: 'service_team_unavailable' });
    expect(
      explorerExclusion(
        bundle({ id: 'lagos', serviceAvailability: 'on_request' }),
        filters({ serviceTeamAvailability: 'available_or_on_request' }),
        flags,
        empty,
        null,
        null,
      ),
    ).toBeNull();
  });

  it('reads hard flags and reports official flood alerts', () => {
    const flagged = bundle({ id: 'lagos' });
    flagged.flags = [
      {
        id: 'f1',
        marketId: 'lagos',
        neighborhoodId: null,
        flagType: 'flood_alert',
        active: true,
        note: 'NIHSA alert',
        sourceId: null,
        validFrom: null,
        validUntil: null,
        approvedBy: null,
        createdBy: null,
        createdAt: asOf,
        updatedAt: asOf,
      },
      {
        id: 'f2',
        marketId: 'lagos',
        neighborhoodId: null,
        flagType: 'title_stop',
        active: true,
        note: 'stop',
        sourceId: null,
        validFrom: null,
        validUntil: '2020-01-01',
        approvedBy: null,
        createdBy: null,
        createdAt: asOf,
        updatedAt: asOf,
      },
    ];
    const result = flagsFor(flagged, asOf);
    expect(result.floodStatus).toBe('official_alert');
    expect(result.titleStop).toBeUndefined();
    expect(
      explorerExclusion(
        flagged,
        filters({ floodExposure: 'exclude_high' }),
        result,
        empty,
        null,
        null,
      ),
    ).toMatchObject({ reason: 'flood_exposure' });
  });
});

describe('runRankingAdapter', () => {
  it('ranks by assumption fit in assumption mode and reports gates in evidence mode', () => {
    const bundles = [bundle({ id: 'b-market' }), bundle({ id: 'a-market' })];
    const evidence = runRankingAdapter({
      bundles,
      policy,
      asOf,
      request: {
        objective: 'long_term_rent',
        mode: 'evidence',
        filters: {},
        priorities: {},
        assumptions: null,
        rank: true,
        budgetCeiling: null,
      },
    });
    expect(evidence.response.rankingEnabled).toBe(false);
    expect(
      evidence.response.organic.every(
        (m) => m.status === 'more_local_data_needed' && m.fit === null,
      ),
    ).toBe(true);
    expect(evidence.response.organic[0]?.missing).toEqual(
      expect.arrayContaining(['local_cost_evidence', 'local_rent_evidence']),
    );

    const assumption = runRankingAdapter({
      bundles,
      policy,
      asOf,
      request: {
        objective: 'long_term_rent',
        mode: 'assumption',
        filters: {},
        priorities: {},
        assumptions,
        rank: true,
        budgetCeiling: null,
      },
    });
    expect(assumption.response.rankingEnabled).toBe(true);
    expect(assumption.response.organic.map((m) => m.rank)).toEqual([1, 2]);
    // Identical assumptions tie; the stable id order breaks the tie.
    expect(assumption.response.organic.map((m) => m.marketId)).toEqual(['a-market', 'b-market']);
    expect(assumption.response.organic[0]?.assumptionFit).not.toBeNull();
    expect(assumption.response.organic[0]?.topContributors.length).toBeGreaterThan(0);
    expect(assumption.marketInputs[0]?.metrics.affordability?.kind).toBe('model_estimate');
  });

  it('excludes every market when the assumed cost exceeds the budget ceiling', () => {
    const out = runRankingAdapter({
      bundles: [bundle({ id: 'lagos' })],
      policy,
      asOf,
      request: {
        objective: 'long_term_rent',
        mode: 'assumption',
        filters: { totalBudgetNaira: 50_000_000 },
        priorities: {},
        assumptions,
        rank: true,
        budgetCeiling: null,
      },
    });
    expect(out.response.organic).toEqual([]);
    expect(out.response.excluded[0]).toMatchObject({
      status: 'excluded',
      exclusionReason: 'assumed_cost_exceeds_budget',
    });
  });

  it('requires assumptions in assumption mode', () => {
    expect(() =>
      runRankingAdapter({
        bundles: [],
        policy,
        asOf,
        request: {
          objective: 'long_term_rent',
          mode: 'assumption',
          filters: {},
          priorities: {},
          assumptions: null,
          rank: true,
          budgetCeiling: null,
        },
      }),
    ).toThrow(/assumption mode requires/);
  });
});
