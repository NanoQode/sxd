import { describe, expect, it } from 'vitest';
import {
  freshnessDataTypeFor,
  observationBadge,
  observationFreshness,
  quoteBadge,
  summariseFreshness,
  supplierLeadBadge,
  supplierLeadNote,
} from './evidence';
import type { FreshnessWindow } from './policy';
import type { ObservationRecord, QuoteRow, SupplierLeadRecord } from './types';

const asOf = new Date('2026-09-23T12:00:00.000Z');

const policies = new Map<string, FreshnessWindow>([
  ['rent_observation', { maxAgeDays: 90, respectSourceValidity: true }],
  ['sale_observation', { maxAgeDays: 90, respectSourceValidity: true }],
  ['material_quote', { maxAgeDays: 14, respectSourceValidity: true }],
  ['official_risk_layer', { maxAgeDays: null, respectSourceValidity: true }],
]);

function record(overrides: {
  observation?: Partial<ObservationRecord['observation']>;
  interpretation?: Partial<ObservationRecord['interpretation']>;
}): ObservationRecord {
  const observation = {
    id: 'obs-1',
    slug: null,
    sourceId: 'src-1',
    sourceUrl: null,
    metric: 'median_annual_asking_rent',
    valueNumeric: '5000000.0000',
    valueLow: null,
    valueHigh: null,
    valueText: null,
    unit: 'NGN/year',
    currency: 'NGN',
    numericRepresentation: 'whole_naira_not_kobo' as const,
    geographyLevel: 'city' as const,
    geographyLabel: 'Ibadan',
    stateId: null,
    marketId: 'mkt-1',
    neighborhoodId: null,
    propertyCohort: 'mixed',
    statistic: 'median' as const,
    observationPeriodStart: '2026-07-01',
    observationPeriodEnd: '2026-09-30',
    periodCompleteAtRetrieval: false,
    sourceUpdatedAt: '2026-09-21',
    retrievedAt: '2026-09-22',
    sampleSize: 214,
    collectionMethod: 'published_report_read',
    licenseNote: null,
    validUntil: null,
    rankEligible: false,
    reasonNotRankEligible: null,
    evidenceFileId: null,
    createdBy: null,
    createdAt: asOf,
    ...overrides.observation,
  };
  const interpretation = {
    id: 'int-1',
    observationId: 'obs-1',
    version: 1,
    isCurrent: true,
    reviewStatus: 'source_read_pending_business_review' as const,
    publicationState: 'published' as const,
    rankEligible: false,
    reasonNotRankEligible: null,
    editorialNote: null,
    cohortMapping: null,
    appliesToMarketId: null,
    freshnessOverrideUntil: null,
    reviewerId: null,
    publishedBy: null,
    publishedAt: null,
    createdBy: null,
    createdAt: asOf,
    ...overrides.interpretation,
  };
  const source = {
    id: 'src-1',
    slug: 'npc',
    title: 'Report',
    publisher: null,
    url: null,
    dataUrl: null,
    licenseNote: null,
    licenseRights: 'unknown' as const,
    useNote: null,
    retrievedAt: '2026-09-22',
    createdBy: null,
    createdAt: asOf,
    updatedAt: asOf,
  };
  return { observation, interpretation, source };
}

describe('observation freshness', () => {
  it('is judged from the observation period, never the retrieval date', () => {
    expect(observationFreshness(record({}), policies, asOf)).toBe('fresh');
    const old = record({
      observation: {
        observationPeriodEnd: '2026-05-01',
        sourceUpdatedAt: '2026-05-02',
        retrievedAt: '2026-09-22',
      },
    });
    expect(observationFreshness(old, policies, asOf)).toBe('stale');
  });

  it('respects the source validity and editorial overrides', () => {
    const validated = record({
      observation: { observationPeriodEnd: '2026-01-01', validUntil: '2026-12-31' },
    });
    expect(observationFreshness(validated, policies, asOf)).toBe('fresh');
    const expired = record({ observation: { validUntil: '2026-09-01' } });
    expect(observationFreshness(expired, policies, asOf)).toBe('stale');
    const overridden = record({
      observation: { observationPeriodEnd: '2026-01-01' },
      interpretation: { freshnessOverrideUntil: '2026-10-01' },
    });
    expect(observationFreshness(overridden, policies, asOf)).toBe('fresh');
  });

  it('reports unknown when no policy or date applies', () => {
    const noDates = record({ observation: { observationPeriodEnd: null, sourceUpdatedAt: null } });
    expect(observationFreshness(noDates, policies, asOf)).toBe('unknown');
    const unmapped = record({ observation: { metric: 'something_else' } });
    expect(observationFreshness(unmapped, policies, asOf)).toBe('unknown');
    expect(freshnessDataTypeFor('land_price_ngn_per_m2')).toBe('sale_observation');
    expect(freshnessDataTypeFor('material_delivery_days')).toBe('material_quote');
    expect(freshnessDataTypeFor('approval_duration_days')).toBe('observed_permit_performance');
  });
});

describe('observation badges', () => {
  it('labels statewide rows as regional context whatever their review state', () => {
    const statewide = record({
      observation: { geographyLevel: 'state_or_fct' },
      interpretation: { reviewStatus: 'verified' },
    });
    expect(observationBadge(statewide, 'fresh')).toBe('regional_context');
    expect(observationBadge(statewide, 'stale')).toBe('regional_context');
  });

  it('distinguishes sourced, verified first-party, stale and disputed', () => {
    expect(observationBadge(record({}), 'fresh')).toBe('sourced_observation');
    expect(observationBadge(record({}), 'stale')).toBe('stale');
    const verifiedFirstParty = record({
      observation: { collectionMethod: 'first_party_survey' },
      interpretation: { reviewStatus: 'verified' },
    });
    expect(observationBadge(verifiedFirstParty, 'fresh')).toBe('verified_operational_record');
    expect(observationBadge(verifiedFirstParty, 'stale')).toBe('stale');
    const verifiedThirdParty = record({ interpretation: { reviewStatus: 'verified' } });
    expect(observationBadge(verifiedThirdParty, 'fresh')).toBe('sourced_observation');
    expect(
      observationBadge(record({ interpretation: { reviewStatus: 'disputed' } }), 'stale'),
    ).toBe('disputed');
  });
});

describe('supplier leads and quotes', () => {
  const lead = (
    relation: SupplierLeadRecord['coverage']['relation'],
    deliveryCoverageVerified = false,
  ): SupplierLeadRecord => ({
    coverage: {
      id: 'cov',
      facilityId: 'fac',
      marketId: 'mkt',
      relation,
      verifiedAt: null,
      verifiedBy: null,
      note: null,
      createdAt: asOf,
    },
    facility: {
      id: 'fac',
      slug: 'dangote-ibese',
      name: 'Dangote Ibese',
      operator: 'Dangote',
      stateId: null,
      material: 'cement',
      sourceId: null,
      evidenceStatus: 'published_facility_location',
      location: null,
      deliveryCoverageVerified,
      stockStatus: 'unknown',
      rankEligible: false,
      contactPermission: false,
      notes: null,
      importFingerprint: null,
      humanEditedAt: null,
      archivedAt: null,
      version: 1,
      createdAt: asOf,
      updatedAt: asOf,
    },
    state: null,
    source: null,
  });

  it('marks editorial leads as regional context with the research-lead note', () => {
    expect(supplierLeadBadge(lead('editorial_lead'))).toBe('regional_context');
    expect(supplierLeadNote(lead('editorial_lead'))).toBe(
      'Research lead, not a verified delivery route.',
    );
    expect(supplierLeadBadge(lead('verified_delivery'))).toBe('verified_operational_record');
    expect(supplierLeadBadge(lead('dealer_appointed'))).toBe('sourced_observation');
    expect(supplierLeadBadge(lead('dealer_appointed', true))).toBe('verified_operational_record');
  });

  it('badges quotes by review status and freshness', () => {
    const quote = { reviewStatus: 'verified' } as QuoteRow;
    expect(quoteBadge(quote, 'fresh')).toBe('verified_operational_record');
    expect(quoteBadge(quote, 'stale')).toBe('stale');
    expect(quoteBadge({ reviewStatus: 'disputed' } as QuoteRow, 'fresh')).toBe('disputed');
    expect(summariseFreshness([])).toBe('unknown');
    expect(summariseFreshness(['stale', 'unknown'])).toBe('stale');
    expect(summariseFreshness(['stale', 'fresh'])).toBe('fresh');
  });
});
