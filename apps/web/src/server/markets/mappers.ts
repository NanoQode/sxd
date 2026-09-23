import type {
  EvidenceBadge,
  EvidenceSummaryDto,
  MarketDetailDto,
  MarketGeoJson,
  MarketSummaryDto,
  ObservationDto,
  SourceRefDto,
  SupplierLeadDto,
  SupplierQuoteDto,
} from '@simplexd/contracts';
import {
  observationBadge,
  observationFreshness,
  quoteBadge,
  quoteFreshness,
  summariseFreshness,
  supplierLeadBadge,
  supplierLeadNote,
  type Freshness,
} from './evidence';
import type { MarketDetailExtras } from './load';
import { deriveEvidence, type EvidenceDerivation } from './market-metrics';
import { MISSING_LABELS } from './metric-map';
import type { FreshnessPolicyMap } from './policy';
import type {
  MarketBundle,
  ObservationRecord,
  QuoteRow,
  SourceRow,
  SupplierLeadRecord,
} from './types';

/** Request-scoped inputs every mapper needs: the evaluation instant and the freshness policies. */
export interface MapContext {
  asOf: Date;
  policies: FreshnessPolicyMap;
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function kobo(value: bigint | null): { amountKobo: string; currency: string } | null {
  return value === null ? null : { amountKobo: value.toString(), currency: 'NGN' };
}

export function toSourceRef(source: SourceRow): SourceRefDto {
  return {
    id: source.id,
    slug: source.slug,
    title: source.title,
    url: source.url,
    licenseNote: source.licenseNote,
    retrievedAt: source.retrievedAt,
  };
}

export function toObservationDto(record: ObservationRecord, ctx: MapContext): ObservationDto {
  const { observation, interpretation, source } = record;
  const freshness = observationFreshness(record, ctx.policies, ctx.asOf);
  return {
    id: observation.id,
    slug: observation.slug,
    metric: observation.metric,
    value: toNumber(observation.valueNumeric),
    valueLow: toNumber(observation.valueLow),
    valueHigh: toNumber(observation.valueHigh),
    valueText: observation.valueText,
    unit: observation.unit,
    currency: observation.currency,
    numericRepresentation: observation.numericRepresentation,
    statistic: observation.statistic,
    propertyCohort: observation.propertyCohort,
    geographyLevel: observation.geographyLevel,
    geographyLabel: observation.geographyLabel,
    marketId: interpretation.appliesToMarketId ?? observation.marketId,
    stateId: observation.stateId,
    observationPeriodStart: observation.observationPeriodStart,
    observationPeriodEnd: observation.observationPeriodEnd,
    periodCompleteAtRetrieval: observation.periodCompleteAtRetrieval,
    sourceUpdatedAt: observation.sourceUpdatedAt,
    retrievedAt: observation.retrievedAt,
    validUntil: interpretation.freshnessOverrideUntil ?? observation.validUntil,
    sampleSize: observation.sampleSize,
    collectionMethod: observation.collectionMethod,
    source: toSourceRef(source),
    badge: observationBadge(record, freshness),
    freshness,
    reviewStatus: interpretation.reviewStatus,
    publicationState: interpretation.publicationState,
    rankEligible: interpretation.rankEligible,
    reasonNotRankEligible:
      interpretation.reasonNotRankEligible ?? observation.reasonNotRankEligible ?? null,
    editorialNote: interpretation.editorialNote,
    interpretationVersion: interpretation.version,
  };
}

export function toSupplierLeadDto(lead: SupplierLeadRecord): SupplierLeadDto {
  const { coverage, facility, state, source } = lead;
  return {
    facilityId: facility.id,
    slug: facility.slug,
    name: facility.name,
    operator: facility.operator,
    material: facility.material,
    stateName: state?.name ?? null,
    evidenceStatus: facility.evidenceStatus,
    stockStatus: facility.stockStatus,
    deliveryCoverageVerified: facility.deliveryCoverageVerified,
    relation: coverage.relation,
    note: supplierLeadNote(lead),
    badge: supplierLeadBadge(lead),
    source: source ? toSourceRef(source) : null,
  };
}

export function toQuoteDto(quote: QuoteRow, ctx: MapContext): SupplierQuoteDto {
  const freshness = quoteFreshness(quote, ctx.policies, ctx.asOf);
  return {
    id: quote.id,
    material: quote.material,
    specification: quote.specification,
    unit: quote.unit,
    quantity: quote.quantity,
    unitPrice: kobo(quote.unitPriceKobo),
    deliveryCost: kobo(quote.deliveryCostKobo),
    leadTimeDays: quote.leadTimeDays,
    quotedAt: quote.quotedAt,
    validUntil: quote.validUntil,
    freshness,
    badge: quoteBadge(quote, freshness),
    rankEligible: quote.rankEligible,
  };
}

const OPEN_TASK_STATUSES: ReadonlySet<string> = new Set([
  'open',
  'in_progress',
  'in_review',
  'blocked',
]);

export function summariseEvidence(bundle: MarketBundle, ctx: MapContext): EvidenceSummaryDto {
  const freshnessValues: Freshness[] = [];
  const badges = new Set<EvidenceBadge>();
  for (const record of [...bundle.local, ...bundle.regional]) {
    const freshness = observationFreshness(record, ctx.policies, ctx.asOf);
    freshnessValues.push(freshness);
    badges.add(observationBadge(record, freshness));
  }
  for (const lead of bundle.leads) badges.add(supplierLeadBadge(lead));
  for (const quote of bundle.quotes) {
    const freshness = quoteFreshness(quote, ctx.policies, ctx.asOf);
    freshnessValues.push(freshness);
    badges.add(quoteBadge(quote, freshness));
  }
  return {
    localObservations: bundle.local.length,
    regionalContextObservations: bundle.regional.length,
    supplierLeads: bundle.leads.length,
    supplierQuotes: bundle.quotes.length,
    openResearchTasks: bundle.tasks.filter((t) => OPEN_TASK_STATUSES.has(t.status)).length,
    lastReviewedAt: iso(bundle.market.lastReviewedAt),
    lastResearchedAt: bundle.market.lastResearchedAt,
    freshness: summariseFreshness(freshnessValues),
    badges: [...badges].sort(),
  };
}

export function deriveForMarket(bundle: MarketBundle, ctx: MapContext): EvidenceDerivation {
  return deriveEvidence(bundle.local, { asOf: ctx.asOf, policies: ctx.policies });
}

/** What still has to be collected before the market can be ranked, in words. */
export function missingEvidenceFor(bundle: MarketBundle, derivation: EvidenceDerivation): string[] {
  const items: string[] = [];
  if (!derivation.hasLocalCostEvidence) items.push(MISSING_LABELS.local_cost_evidence);
  if (!derivation.hasLocalRentEvidence) items.push(MISSING_LABELS.local_rent_evidence);
  for (const task of bundle.tasks) {
    if (OPEN_TASK_STATUSES.has(task.status)) items.push(task.title);
  }
  return [...new Set(items)];
}

export function toMarketSummary(bundle: MarketBundle, ctx: MapContext): MarketSummaryDto {
  const { market, state } = bundle;
  const derivation = deriveForMarket(bundle, ctx);
  return {
    id: market.id,
    slug: market.slug,
    name: market.name,
    aliases: market.aliases,
    stateId: state.id,
    stateName: state.name,
    isFederalCapital: state.isFederalCapital,
    geopoliticalZone: market.geopoliticalZone,
    displayOrder: market.displayOrder,
    location: market.location,
    coordinateAccuracy: market.coordinateAccuracy,
    parentMarketId: market.parentMarketId,
    overlapNote: market.overlapNote,
    serviceAvailability: market.serviceAvailability,
    publicationState: market.publicationState,
    recommendationStatus: market.recommendationStatus,
    evidence: summariseEvidence(bundle, ctx),
    metrics: derivation.metrics,
    version: market.version,
  };
}

export function toMarketDetail(
  bundle: MarketBundle,
  extras: MarketDetailExtras,
  coordinateSource: SourceRow | null,
  ctx: MapContext,
): MarketDetailDto {
  const { market } = bundle;
  const summary = toMarketSummary(bundle, ctx);
  const derivation = deriveForMarket(bundle, ctx);
  const template = extras.timelineTemplate;
  return {
    ...summary,
    selectionBasis: market.selectionBasis,
    coordinateSource: coordinateSource ? toSourceRef(coordinateSource) : null,
    sourceCityName: market.sourceCityName,
    profileMarkdown: market.profileMarkdown,
    supplyMappingMethod: market.supplyMappingMethod,
    researchTasks: bundle.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      category: t.category,
      status: t.status,
    })),
    neighborhoods: extras.neighborhoods.map((n) => ({
      id: n.id,
      slug: n.slug,
      name: n.name,
      hasBoundary: n.hasBoundary,
      centroid: n.centroid,
      publicationState: n.publicationState,
      profileMarkdown: n.profileMarkdown,
      version: n.version,
    })),
    localObservations: bundle.local.map((r) => toObservationDto(r, ctx)),
    regionalContextObservations: bundle.regional.map((r) => toObservationDto(r, ctx)),
    supplierLeads: bundle.leads.map(toSupplierLeadDto),
    supplierQuotes: bundle.quotes.map((q) => toQuoteDto(q, ctx)),
    serviceCoverage: extras.serviceCoverage.map(({ coverage, service }) => ({
      serviceSlug: service.slug,
      serviceName: service.name,
      availability: coverage.availability,
      note: coverage.note,
    })),
    flags: bundle.flags.map((f) => ({
      id: f.id,
      flagType: f.flagType,
      note: f.note,
      validFrom: f.validFrom,
      validUntil: f.validUntil,
      active: f.active,
    })),
    missingEvidence: missingEvidenceFor(bundle, derivation),
    timelineTemplate: template
      ? {
          key: template.key,
          name: template.name,
          status: template.status,
          canComputeCompletionDate:
            template.status !== 'demo_only' && (template.missingInputs ?? []).length === 0,
          missingInputs: template.missingInputs ?? [],
          assumptionNotes: template.assumptionNotes,
        }
      : null,
    lastReviewedAt: iso(market.lastReviewedAt),
    publishedAt: iso(market.publishedAt),
    importedAt: iso(market.importedAt),
    humanEditedAt: iso(market.humanEditedAt),
  };
}

export function toGeoFeature(
  bundle: MarketBundle,
  ctx: MapContext,
): MarketGeoJson['features'][number] {
  const { market, state } = bundle;
  const evidence = summariseEvidence(bundle, ctx);
  return {
    type: 'Feature',
    id: market.slug,
    geometry: { type: 'Point', coordinates: [market.location.lon, market.location.lat] },
    properties: {
      id: market.id,
      slug: market.slug,
      name: market.name,
      stateName: state.name,
      zone: market.geopoliticalZone,
      serviceAvailability: market.serviceAvailability,
      recommendationStatus: market.recommendationStatus,
      evidenceFreshness: evidence.freshness,
      localObservations: evidence.localObservations,
      regionalContextObservations: evidence.regionalContextObservations,
      parentMarketId: market.parentMarketId,
    },
  };
}
