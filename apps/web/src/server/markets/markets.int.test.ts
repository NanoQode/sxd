import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  comparisonResponseSchema,
  marketDetailSchema,
  marketGeoJsonSchema,
  marketListQuerySchema,
  marketListResponseSchema,
  marketObservationsPageSchema,
  marketObservationsQuerySchema,
  recommendationRequestSchema,
  recommendationResponseSchema,
  stateWithCountsSchema,
  type ScenarioAssumptions,
} from '@simplexd/contracts';
import { closeDb, schema } from '@simplexd/db';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';
import { runComparison } from './comparisons';
import {
  getMarketBySlug,
  listMarketObservations,
  listMarkets,
  listStatesWithCounts,
  marketsGeoJson,
} from './queries';
import { runRecommendation } from './recommendations';
import { anonymousIdentity, PUBLISHED_SLUGS, seedAndPublish, staffIdentity } from './test-fixtures';

let dbs: TestDatabases;
const anon = anonymousIdentity('tok-markets');
const staff = staffIdentity('staff-markets');

async function marketId(slug: string): Promise<string> {
  const [row] = await dbs.owner
    .select({ id: schema.markets.id })
    .from(schema.markets)
    .where(eq(schema.markets.slug, slug));
  if (!row) throw new Error(`market ${slug} missing`);
  return row.id;
}

/** The brief's hypothetical example plus a land/build cost basis. */
const baseAssumptions: ScenarioAssumptions = {
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
    completionDelayMonths: 0,
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

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  await seedAndPublish(dbs.owner);
});

afterAll(async () => {
  await closeDb();
  await dbs.close();
});

describe('listMarkets', () => {
  it('shows only published markets to anonymous visitors and satisfies the contract', async () => {
    const result = await listMarkets(marketListQuerySchema.parse({}), anon);
    expect(() => marketListResponseSchema.parse(result)).not.toThrow();
    expect(result.total).toBe(PUBLISHED_SLUGS.length);
    expect(result.items.map((m) => m.slug).sort()).toEqual([...PUBLISHED_SLUGS].sort());
    expect(result.items.every((m) => m.publicationState === 'published')).toBe(true);
    expect(result.policy).toEqual({
      activeRankingPolicyVersion: 1,
      defaultFinancialRankingEnabled: false,
      coverageThreshold: 0.7,
    });
    // Metrics stay null: the seed carries no rank-eligible local evidence.
    for (const item of result.items) {
      expect(Object.values(item.metrics).every((v) => v === null)).toBe(true);
    }
  });

  it('ignores includeUnpublished for anonymous visitors but honours it for data staff', async () => {
    const ignored = await listMarkets(
      marketListQuerySchema.parse({ includeUnpublished: 'true' }),
      anon,
    );
    expect(ignored.total).toBe(PUBLISHED_SLUGS.length);
    const drafts = await listMarkets(
      marketListQuerySchema.parse({ includeUnpublished: 'true' }),
      staff,
    );
    expect(drafts.total).toBe(50);
    expect(drafts.items.some((m) => m.publicationState === 'draft')).toBe(true);
    const published = await listMarkets(marketListQuerySchema.parse({}), staff);
    expect(published.total).toBe(PUBLISHED_SLUGS.length);
  });

  it('filters by bbox with a PostGIS envelope', async () => {
    const result = await listMarkets(
      marketListQuerySchema.parse({ bbox: '3.2,6.3,3.7,6.7' }),
      anon,
    );
    expect(result.items.map((m) => m.slug).sort()).toEqual(['ng-ikeja', 'ng-ikorodu', 'ng-lagos']);
    // A wider envelope (to lon 4.0) reaches Epe (3.98, 6.58) but not Ibadan (3.91, 7.38).
    const staffView = await listMarkets(
      marketListQuerySchema.parse({ bbox: '3.2,6.3,4.0,6.7', includeUnpublished: 'true' }),
      staff,
    );
    expect(staffView.items.map((m) => m.slug)).not.toContain('ng-ibadan');
    expect(staffView.items.map((m) => m.slug)).toContain('ng-epe');
  });

  it('matches aliases with q and applies evidenceStatus, zone and stateId filters', async () => {
    const byAlias = await listMarkets(marketListQuerySchema.parse({ q: 'shagamu' }), anon);
    expect(byAlias.items.map((m) => m.slug)).toEqual(['ng-sagamu']);
    const literal = await listMarkets(marketListQuerySchema.parse({ q: '%' }), anon);
    expect(literal.total).toBe(0);
    const local = await listMarkets(
      marketListQuerySchema.parse({ evidenceStatus: 'has_local' }),
      anon,
    );
    expect(local.items.map((m) => m.slug)).toEqual(['ng-ibadan']);
    const none = await listMarkets(marketListQuerySchema.parse({ evidenceStatus: 'none' }), anon);
    expect(none.total).toBe(0);
    const sw = await listMarkets(marketListQuerySchema.parse({ zone: 'SW' }), anon);
    expect(sw.items.every((m) => m.geopoliticalZone === 'SW')).toBe(true);
    expect(sw.total).toBe(PUBLISHED_SLUGS.length - 1);
    const lagosState = sw.items.find((m) => m.slug === 'ng-lagos')!.stateId;
    const byState = await listMarkets(marketListQuerySchema.parse({ stateId: lagosState }), anon);
    expect(byState.items.map((m) => m.slug).sort()).toEqual(['ng-ikeja', 'ng-ikorodu', 'ng-lagos']);
  });
});

describe('marketsGeoJson', () => {
  it('returns one feature per published market with longitude, latitude order', async () => {
    const geo = await marketsGeoJson(anon);
    expect(() => marketGeoJsonSchema.parse(geo)).not.toThrow();
    expect(geo.features).toHaveLength(PUBLISHED_SLUGS.length);
    const ikeja = geo.features.find((f) => f.properties.slug === 'ng-ikeja')!;
    expect(ikeja.geometry.coordinates).toEqual([3.3426, 6.6186]);
    expect(ikeja.properties.parentMarketId).toBe(await marketId('ng-lagos'));
    expect(ikeja.properties.regionalContextObservations).toBe(2);
  });
});

describe('getMarketBySlug', () => {
  it('lists Ibadan local observations, statewide context and supplier leads with badges', async () => {
    const detail = await getMarketBySlug('ng-ibadan', anon);
    expect(detail).not.toBeNull();
    expect(() => marketDetailSchema.parse(detail)).not.toThrow();
    const d = detail!;
    expect(d.localObservations).toHaveLength(2);
    expect(d.localObservations.map((o) => o.slug).sort()).toEqual([
      'npc-ibadan-rent',
      'npc-ibadan-sale',
    ]);
    for (const obs of d.localObservations) {
      expect(['sourced_observation', 'stale']).toContain(obs.badge);
      expect(obs.geographyLevel).toBe('city');
      expect(obs.rankEligible).toBe(false);
      expect(obs.publicationState).toBe('published');
      expect(obs.source.slug).toBe('npc-q3-2026');
    }
    expect(d.regionalContextObservations).toHaveLength(2);
    expect(d.regionalContextObservations.every((o) => o.badge === 'regional_context')).toBe(true);
    expect(d.regionalContextObservations.every((o) => o.geographyLevel === 'state_or_fct')).toBe(
      true,
    );
    expect(d.supplierLeads).toHaveLength(3);
    for (const lead of d.supplierLeads) {
      expect(lead.badge).toBe('regional_context');
      expect(lead.relation).toBe('editorial_lead');
      expect(lead.note).toContain('Research lead, not a verified delivery route');
    }
    expect(d.evidence.localObservations).toBe(2);
    expect(d.evidence.regionalContextObservations).toBe(2);
    expect(d.evidence.supplierLeads).toBe(3);
    expect(d.evidence.openResearchTasks).toBe(6);
    expect(Object.values(d.metrics).every((v) => v === null)).toBe(true);
    expect(d.missingEvidence.length).toBeGreaterThan(0);
    expect(d.timelineTemplate?.canComputeCompletionDate).toBe(false);
    expect(d.recommendationStatus).toBe('insufficient_local_evidence');
  });

  it('hides draft markets from anonymous visitors and shows them to data staff', async () => {
    expect(await getMarketBySlug('ng-abakaliki', anon)).toBeNull();
    const draft = await getMarketBySlug('ng-abakaliki', staff);
    expect(draft?.publicationState).toBe('draft');
    expect(draft?.localObservations).toEqual([]);
    expect(draft?.supplierLeads).toHaveLength(2);
  });

  it('resolves a market by id as well as by slug', async () => {
    const id = await marketId('ng-lagos');
    const detail = await getMarketBySlug(id, anon);
    expect(detail?.slug).toBe('ng-lagos');
  });
});

describe('listMarketObservations', () => {
  it('pages local rows first, then statewide context, by cursor', async () => {
    const first = await listMarketObservations(
      'ng-ibadan',
      marketObservationsQuerySchema.parse({ limit: '2' }),
      anon,
    );
    expect(first).not.toBeNull();
    expect(() => marketObservationsPageSchema.parse(first)).not.toThrow();
    expect(first!.total).toBe(4);
    expect(first!.items.every((o) => o.geographyLevel === 'city')).toBe(true);
    expect(first!.nextCursor).not.toBeNull();
    const second = await listMarketObservations(
      'ng-ibadan',
      marketObservationsQuerySchema.parse({ limit: '2', cursor: first!.nextCursor! }),
      anon,
    );
    expect(second!.items.every((o) => o.badge === 'regional_context')).toBe(true);
    expect(second!.nextCursor).toBeNull();
    const regionalOnly = await listMarketObservations(
      'ng-ibadan',
      marketObservationsQuerySchema.parse({ scope: 'regional' }),
      anon,
    );
    expect(regionalOnly!.total).toBe(2);
    expect(
      await listMarketObservations('ng-abakaliki', marketObservationsQuerySchema.parse({}), anon),
    ).toBeNull();
  });
});

describe('listStatesWithCounts', () => {
  it('counts visible markets per state', async () => {
    const states = await listStatesWithCounts(anon);
    expect(states).toHaveLength(37);
    for (const s of states) expect(() => stateWithCountsSchema.parse(s)).not.toThrow();
    expect(states.find((s) => s.name === 'Lagos')?.marketCount).toBe(3);
    expect(states.find((s) => s.name === 'Oyo')?.marketCount).toBe(1);
    expect(states.find((s) => s.name === 'Ebonyi')?.marketCount).toBe(0);
    const staffStates = await listStatesWithCounts(staff);
    expect(staffStates.find((s) => s.name === 'Lagos')?.marketCount).toBe(4);
    expect(staffStates.find((s) => s.name === 'Federal Capital Territory')?.isFederalCapital).toBe(
      true,
    );
  });
});

describe('runRecommendation', () => {
  it('evidence mode: no fit, every market needs more local data and ranking is gated by policy', async () => {
    const request = recommendationRequestSchema.parse({
      objective: 'long_term_rent',
      mode: 'evidence',
    });
    const run = await runRecommendation(request, anon);
    const response = run.response;
    expect(() => recommendationResponseSchema.parse(response)).not.toThrow();
    expect(response.policyVersion).toBe(1);
    expect(response.rankingEnabled).toBe(false);
    expect(response.rankingDisabledReason).toContain('switched off');
    expect(response.organic).toHaveLength(PUBLISHED_SLUGS.length);
    for (const market of response.organic) {
      expect(market.status).toBe('more_local_data_needed');
      expect(market.fit).toBeNull();
      expect(market.rank).toBeNull();
      expect(market.assumptionFit).toBeNull();
      expect(market.missing.length).toBeGreaterThan(0);
      expect(market.missing).toContain('local_cost_evidence');
      expect(market.missing).toContain('local_rent_evidence');
      expect(market.missingEvidence.length).toBeGreaterThan(0);
      expect(market.riskAssessment).toEqual({
        flood: 'unable_to_assess',
        title: 'unable_to_assess',
      });
      expect(market.metrics.every((m) => m.value === null && m.eligible === false)).toBe(true);
    }
    expect(response.excluded).toEqual([]);
    expect(run.snapshot.policyVersion).toBe(1);
    expect(run.snapshot.generatedFrom.sourceVersions['ranking_policy']).toMatch(/^v1:/);
  });

  it('assumption mode: assumption fits from the user inputs, evidence stays separate', async () => {
    const request = recommendationRequestSchema.parse({
      objective: 'long_term_rent',
      mode: 'assumption',
      assumptions: baseAssumptions,
    });
    const response = (await runRecommendation(request, anon)).response;
    expect(() => recommendationResponseSchema.parse(response)).not.toThrow();
    expect(response.rankingEnabled).toBe(true);
    expect(response.mode).toBe('assumption');
    expect(response.organic).toHaveLength(PUBLISHED_SLUGS.length);
    for (const market of response.organic) {
      expect(market.assumptionFit).not.toBeNull();
      expect(market.fit).toBeNull();
      expect(market.status).toBe('more_local_data_needed');
      expect(typeof market.rank).toBe('number');
      const affordability = market.metrics.find((m) => m.metric === 'affordability')!;
      // 20m land + 400 m2 x 200k = 100m over 400 m2 = 250,000 NGN/m2
      expect(affordability.value).toBe(250_000);
      expect(affordability.badge).toBe('model_estimate');
      expect(affordability.eligible).toBe(true);
      const yieldMetric = market.metrics.find((m) => m.metric === 'net_rental_economics')!;
      expect(yieldMetric.value).toBeCloseTo(4.2, 10);
      const duration = market.metrics.find((m) => m.metric === 'construction_duration')!;
      expect(duration.value).toBe(360);
      expect(duration.badge).toBe('user_assumption');
      expect(market.whyMatches.length).toBeGreaterThan(0);
      expect(market.whyMatches.join(' ')).toContain('your assumption');
    }
    const ranks = response.organic.map((m) => m.rank);
    expect(ranks).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('assumption mode never scores a zero-cost scenario as a perfect affordability', async () => {
    const zeroCost: ScenarioAssumptions = {
      ...baseAssumptions,
      base: {
        ...baseAssumptions.base,
        landCostNaira: 0,
        buildRateNairaPerM2: null,
        boqTotalNaira: null,
      },
    };
    const request = recommendationRequestSchema.parse({
      objective: 'long_term_rent',
      mode: 'assumption',
      assumptions: zeroCost,
    });
    const response = (await runRecommendation(request, anon)).response;
    const winner = response.organic.find((m) => m.rank === 1)!;
    const affordability = winner.metrics.find((m) => m.metric === 'affordability')!;
    expect(affordability.value).toBeNull();
    expect(affordability.eligible).toBe(false);
    expect(winner.metrics.find((m) => m.metric === 'net_rental_economics')!.value).toBeNull();
    expect(winner.whyMatches.join(' ')).not.toContain('Affordability');
  });

  it('applies explorer filters as hard constraints with reasons', async () => {
    const request = recommendationRequestSchema.parse({
      objective: 'owner_occupation',
      mode: 'assumption',
      assumptions: baseAssumptions,
      filters: { preferredZones: ['NC'], serviceTeamAvailability: 'available_only' },
    });
    const response = (await runRecommendation(request, anon)).response;
    expect(response.organic).toEqual([]);
    expect(response.excluded).toHaveLength(PUBLISHED_SLUGS.length);
    const abuja = response.excluded.find((m) => m.slug === 'ng-abuja')!;
    expect(abuja.exclusionReason).toBe('service_team_unavailable');
    const lagos = response.excluded.find((m) => m.slug === 'ng-lagos')!;
    expect(lagos.exclusionReason).toBe('outside_preferred_zones');
    expect(response.effectiveWeights.net_rental_economics).toBe(0);
  });

  it('rejects unknown or unpublished market ids', async () => {
    const draftId = await marketId('ng-abakaliki');
    const request = recommendationRequestSchema.parse({
      objective: 'long_term_rent',
      marketIds: [draftId],
    });
    await expect(runRecommendation(request, anon)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('runComparison', () => {
  it('compares markets with labelled statewide context and overlap warnings', async () => {
    const [lagos, ikeja, ibadan] = await Promise.all([
      marketId('ng-lagos'),
      marketId('ng-ikeja'),
      marketId('ng-ibadan'),
    ]);
    const comparison = await runComparison(
      {
        marketIds: [lagos, ikeja, ibadan],
        objective: 'long_term_rent',
        mode: 'assumption',
        priorities: {},
        assumptions: baseAssumptions,
      },
      anon,
    );
    expect(() => comparisonResponseSchema.parse(comparison)).not.toThrow();
    expect(comparison.policyVersion).toBe(1);
    expect(comparison.markets.map((m) => m.marketId)).toEqual([lagos, ikeja, ibadan]);
    expect(comparison.overlapWarnings).toHaveLength(1);
    expect(comparison.overlapWarnings[0]!.marketIds.sort()).toEqual([lagos, ikeja].sort());
    expect(comparison.overlapWarnings[0]!.message).toContain('must not be summed');
    const rentRow = comparison.rows.find((r) => r.metric === 'context:median_annual_asking_rent')!;
    const lagosCell = rentRow.cells.find((c) => c.marketId === lagos)!;
    expect(lagosCell.label).toBe('statewide context');
    expect(lagosCell.badge).toBe('regional_context');
    expect(lagosCell.value).toBe(14_000_000);
    const ibadanCell = rentRow.cells.find((c) => c.marketId === ibadan)!;
    expect(ibadanCell.label).toBe('city observation');
    expect(ibadanCell.value).toBe(5_000_000);
    const affordabilityRow = comparison.rows.find((r) => r.metric === 'affordability')!;
    expect(affordabilityRow.cells.every((c) => c.label === 'your assumption')).toBe(true);
    expect(comparison.calculators).toHaveLength(3);
    expect(comparison.calculators.every((c) => c.set === 'base')).toBe(true);
    expect(comparison.reportTitle).toContain('Lagos vs Ikeja vs Ibadan');
  });
});
