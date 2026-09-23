import type { EvidenceBadge } from '@simplexd/contracts';
import { freshnessDataTypeFor, isFresh } from '@simplexd/domain/evidence';
import {
  DEFAULT_FRESHNESS_DAYS,
  type GeographicLevel,
  type MetricKey,
  type SourceQuality,
} from '@simplexd/domain/ranking';
import { rankingMetricFor } from './metric-map';
import type { FreshnessPolicyMap, FreshnessWindow } from './policy';
import type {
  MarketFlagRow,
  ObservationRecord,
  ObservationRow,
  QuoteRow,
  SupplierLeadRecord,
} from './types';

/**
 * Evidence rules for the read model. Every badge, freshness verdict and
 * source-quality label is derived from the observation, its current
 * interpretation and the editable freshness policies. Import time is never a
 * freshness input; retrieval date is not the observation date.
 */

export type Freshness = 'fresh' | 'stale' | 'unknown';

export const CONTEXT_LEVELS: ReadonlySet<string> = new Set(['state_or_fct', 'country']);

const FIRST_PARTY_METHODS: ReadonlySet<string> = new Set([
  'first_party',
  'first_party_survey',
  'first_party_quote',
  'first_party_record',
  'site_visit',
  'staff_survey',
  'operational_record',
]);

export function isFirstPartyMethod(method: string | null | undefined): boolean {
  if (!method) return false;
  const m = method.toLowerCase();
  return m.startsWith('first_party') || FIRST_PARTY_METHODS.has(m);
}

/**
 * The freshness data type (freshness_policies.data_type) that governs an
 * observation metric. Lives in the domain package so the worker's
 * stale-evidence sweep applies the same mapping.
 */
export { freshnessDataTypeFor };

/**
 * The window to judge an observation metric by: the configured freshness
 * policy for its data type, else the engine's default window when the metric
 * feeds a ranking metric, else null (freshness unknown).
 */
export function freshnessWindowFor(
  metric: string,
  policies: FreshnessPolicyMap,
): FreshnessWindow | null {
  const dataType = freshnessDataTypeFor(metric);
  const configured = dataType ? policies.get(dataType) : undefined;
  if (configured) return configured;
  const ranking: MetricKey | null = rankingMetricFor(metric);
  if (ranking) return { maxAgeDays: DEFAULT_FRESHNESS_DAYS[ranking], respectSourceValidity: true };
  return null;
}

/** The date an observation describes: period end, else the source's own update date. Never the retrieval date. */
export function observationDate(observation: ObservationRow): string | null {
  return observation.observationPeriodEnd ?? observation.sourceUpdatedAt ?? null;
}

/** Source validity: an editorial override on the interpretation wins over the source's valid-until. */
export function observationValidUntil(record: ObservationRecord): string | null {
  return record.interpretation.freshnessOverrideUntil ?? record.observation.validUntil ?? null;
}

export function observationFreshness(
  record: ObservationRecord,
  policies: FreshnessPolicyMap,
  asOf: Date,
): Freshness {
  if (record.interpretation.reviewStatus === 'stale') return 'stale';
  const window = freshnessWindowFor(record.observation.metric, policies);
  if (!window) return 'unknown';
  const observedAt = observationDate(record.observation);
  const validUntil = observationValidUntil(record);
  if (!observedAt && !validUntil) return 'unknown';
  return isFresh(
    {
      observedAt,
      validUntil,
      maxAgeDays: window.maxAgeDays,
      respectSourceValidity: window.respectSourceValidity,
    },
    asOf,
  )
    ? 'fresh'
    : 'stale';
}

/**
 * Badge precedence: statewide/national rows are always regional context;
 * a disputed review stays disputed; stale beats verified (a stale record is
 * inspectable, never a current value); verified first-party records are
 * operational records; everything else is a sourced observation.
 */
export function observationBadge(record: ObservationRecord, freshness: Freshness): EvidenceBadge {
  const { observation, interpretation } = record;
  if (CONTEXT_LEVELS.has(observation.geographyLevel)) return 'regional_context';
  if (interpretation.reviewStatus === 'disputed') return 'disputed';
  if (freshness === 'stale') return 'stale';
  if (
    interpretation.reviewStatus === 'verified' &&
    isFirstPartyMethod(observation.collectionMethod)
  )
    return 'verified_operational_record';
  return 'sourced_observation';
}

/** Source-quality rubric key for the confidence multiplier. Configuration, not judgment. */
export function observationSourceQuality(record: ObservationRecord): SourceQuality {
  const { observation, interpretation, source } = record;
  const method = observation.collectionMethod?.toLowerCase() ?? '';
  if (interpretation.reviewStatus === 'verified' && isFirstPartyMethod(method))
    return 'first_party_verified';
  if (source.licenseRights === 'licensed_commercial') return 'licensed_dataset';
  if (method.includes('official')) return 'official_publication';
  if (method === 'published_report_read') return 'published_report_read';
  return 'unverified_lead';
}

export function isLocalLevel(level: string): level is 'city' | 'neighborhood' | 'site' {
  return level === 'city' || level === 'neighborhood' || level === 'site';
}

export function toGeographicLevel(level: string): GeographicLevel {
  switch (level) {
    case 'site':
    case 'neighborhood':
    case 'city':
    case 'state_or_fct':
    case 'country':
      return level;
    default:
      return 'country';
  }
}

/** Supplier leads: an editorial lead is research context, never a delivery route. */
export function supplierLeadBadge(lead: SupplierLeadRecord): EvidenceBadge {
  const { coverage, facility } = lead;
  if (coverage.relation === 'editorial_lead') return 'regional_context';
  if (coverage.relation === 'verified_delivery') return 'verified_operational_record';
  return facility.deliveryCoverageVerified ? 'verified_operational_record' : 'sourced_observation';
}

export const EDITORIAL_LEAD_NOTE = 'Research lead, not a verified delivery route.';

export function supplierLeadNote(lead: SupplierLeadRecord): string | null {
  const parts: string[] = [];
  if (lead.coverage.relation === 'editorial_lead') parts.push(EDITORIAL_LEAD_NOTE);
  if (lead.coverage.note) parts.push(lead.coverage.note);
  else if (lead.facility.notes) parts.push(lead.facility.notes);
  return parts.length > 0 ? parts.join(' ') : null;
}

export function quoteFreshness(
  quote: QuoteRow,
  policies: FreshnessPolicyMap,
  asOf: Date,
): Freshness {
  if (quote.reviewStatus === 'stale') return 'stale';
  const window = policies.get('material_quote') ?? { maxAgeDays: 14, respectSourceValidity: true };
  return isFresh(
    {
      observedAt: quote.quotedAt,
      validUntil: quote.validUntil,
      maxAgeDays: window.maxAgeDays,
      respectSourceValidity: window.respectSourceValidity,
    },
    asOf,
  )
    ? 'fresh'
    : 'stale';
}

export function quoteBadge(quote: QuoteRow, freshness: Freshness): EvidenceBadge {
  if (quote.reviewStatus === 'disputed') return 'disputed';
  if (freshness === 'stale') return 'stale';
  if (quote.reviewStatus === 'verified') return 'verified_operational_record';
  return 'sourced_observation';
}

/** A flag applies today when it is active and inside its validity window. */
export function flagApplies(flag: MarketFlagRow, asOf: Date): boolean {
  if (!flag.active) return false;
  const today = asOf.toISOString().slice(0, 10);
  if (flag.validFrom && flag.validFrom > today) return false;
  if (flag.validUntil && flag.validUntil < today) return false;
  return true;
}

/** Overall freshness of a market's evidence: fresh when anything is fresh, unknown when nothing exists. */
export function summariseFreshness(values: readonly Freshness[]): Freshness {
  if (values.length === 0) return 'unknown';
  if (values.includes('fresh')) return 'fresh';
  if (values.includes('stale')) return 'stale';
  return 'unknown';
}
