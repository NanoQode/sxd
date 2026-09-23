import type {
  ExplorerFilters,
  MarketMetricDto,
  MarketSummaryDto,
  RankedMarketDto,
} from '@simplexd/contracts';
import type { AmenityStatus, FloodStatus } from './types';
import type { AmenityPreference } from './url-state';

/**
 * Client-side filtering of the (at most a few hundred) market summaries. The
 * server list endpoint filters by objective; everything else is applied here
 * so a filter change never waits on the network.
 *
 * Unknown is a real value: a market whose evidence is unknown for a selected
 * optional criterion stays visible while `includeUnknown` is on, and is never
 * silently treated as satisfying (or failing) that criterion.
 */

export type AmenityKey =
  | 'power'
  | 'water'
  | 'internet'
  | 'transport'
  | 'schools'
  | 'hospitals'
  | 'soilInvestigation';

const AMENITY_METRICS: Record<AmenityKey, readonly string[]> = {
  power: ['power', 'power_supply', 'power_provision', 'grid_power_hours'],
  water: ['water', 'water_supply', 'water_provision'],
  internet: ['internet', 'broadband', 'internet_access'],
  transport: ['transport', 'transport_access', 'road_access'],
  schools: ['schools', 'school_access'],
  hospitals: ['hospitals', 'hospital_access', 'healthcare'],
  soilInvestigation: ['soil', 'soil_investigation', 'soil_investigations'],
};

const FLOOD_METRICS = ['flood', 'flood_exposure', 'flood_risk'] as const;
const YIELD_METRICS = [
  'net_rental_economics',
  'projected_net_yield_percent',
  'net_yield_percent',
  'net_yield',
] as const;

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** First non-null metric whose key matches one of the candidates (case/format tolerant). */
export function metricOf(
  market: Pick<MarketSummaryDto, 'metrics'>,
  candidates: readonly string[],
): MarketMetricDto | null {
  const wanted = candidates.map(normaliseKey);
  for (const [key, metric] of Object.entries(market.metrics)) {
    if (metric && wanted.includes(normaliseKey(key))) return metric;
  }
  return null;
}

export function amenityStatus(metric: MarketMetricDto | null): AmenityStatus {
  if (!metric || metric.value === null || !Number.isFinite(metric.value)) return 'unknown';
  if (metric.value > 0) return 'present';
  if (metric.value === 0) return 'absent';
  return 'unknown';
}

const FLOOD_STATUSES: readonly FloodStatus[] = [
  'unknown',
  'low',
  'moderate',
  'high',
  'official_alert',
];

/**
 * Flood status from the ranking's risk assessment when available, otherwise
 * from a flood metric's text. Anything unrecognised is `unknown`, which the
 * brief says "is not low risk".
 */
export function floodStatusOf(
  market: Pick<MarketSummaryDto, 'metrics'>,
  ranked: Pick<RankedMarketDto, 'riskAssessment'> | null | undefined,
): FloodStatus {
  const assessed = ranked?.riskAssessment.flood;
  if (assessed) {
    if (assessed === 'unable_to_assess') return 'unknown';
    if ((FLOOD_STATUSES as readonly string[]).includes(assessed)) return assessed as FloodStatus;
  }
  const metric = metricOf(market, FLOOD_METRICS);
  const text = (metric?.note ?? '').toLowerCase();
  if (text.includes('alert')) return 'official_alert';
  if (text.includes('high')) return 'high';
  if (text.includes('moderate') || text.includes('medium')) return 'moderate';
  if (text.includes('low')) return 'low';
  return 'unknown';
}

function amenityPasses(
  status: AmenityStatus,
  preference: AmenityPreference,
  includeUnknown: boolean,
): boolean {
  switch (preference) {
    case 'any':
    case 'preferred':
      return true;
    case 'required':
      return status === 'present' || (status === 'unknown' && includeUnknown);
    case 'unknown_ok':
      return status !== 'absent';
  }
}

export function floodPasses(
  status: FloodStatus,
  preference: ExplorerFilters['floodExposure'],
  includeUnknown: boolean,
): boolean {
  switch (preference) {
    case 'any':
      return true;
    case 'low_only':
      return status === 'low' || (status === 'unknown' && includeUnknown);
    case 'exclude_high':
      if (status === 'high' || status === 'official_alert') return false;
      return status !== 'unknown' || includeUnknown;
    case 'unknown_ok':
      return status === 'low' || status === 'unknown';
  }
}

export function matchesQuery(
  market: Pick<MarketSummaryDto, 'name' | 'stateName' | 'aliases' | 'slug'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return [market.name, market.stateName, market.slug, ...market.aliases].some((value) =>
    value.toLowerCase().includes(q),
  );
}

export function serviceTeamPasses(
  availability: MarketSummaryDto['serviceAvailability'],
  preference: ExplorerFilters['serviceTeamAvailability'],
): boolean {
  switch (preference) {
    case 'any':
      return true;
    case 'available_only':
      return availability === 'available';
    case 'available_or_on_request':
      return (
        availability === 'available' || availability === 'limited' || availability === 'on_request'
      );
  }
}

export interface FilterContext {
  /** Ranking results keyed by market slug, when a recommendation has been computed. */
  rankedBySlug?: ReadonlyMap<string, RankedMarketDto>;
}

/** Applies every client-side filter; the order of `markets` is preserved. */
export function applyClientFilters(
  markets: readonly MarketSummaryDto[],
  filters: ExplorerFilters,
  context: FilterContext = {},
): MarketSummaryDto[] {
  const include = filters.includeUnknown;
  const amenityPreferences: Array<[AmenityKey, AmenityPreference]> = [
    ['power', filters.power],
    ['water', filters.water],
    ['internet', filters.internet],
    ['transport', filters.transport],
    ['schools', filters.schools],
    ['hospitals', filters.hospitals],
    ['soilInvestigation', filters.soilInvestigation],
  ];

  return markets.filter((market) => {
    if (filters.preferredZones.length > 0 && !filters.preferredZones.includes(market.geopoliticalZone))
      return false;
    if (filters.preferredStateIds.length > 0 && !filters.preferredStateIds.includes(market.stateId))
      return false;
    if (filters.evidenceFreshness === 'fresh_only' && market.evidence.freshness === 'stale')
      return false;
    if (!serviceTeamPasses(market.serviceAvailability, filters.serviceTeamAvailability))
      return false;

    for (const [key, preference] of amenityPreferences) {
      if (preference === 'any' || preference === 'preferred') continue;
      const status = amenityStatus(metricOf(market, AMENITY_METRICS[key]));
      if (!amenityPasses(status, preference, include)) return false;
    }

    const ranked = context.rankedBySlug?.get(market.slug) ?? null;
    if (!floodPasses(floodStatusOf(market, ranked), filters.floodExposure, include)) return false;

    if (filters.minProjectedNetYieldPercent !== null) {
      const metric = metricOf(market, YIELD_METRICS);
      if (metric && metric.value !== null) {
        if (metric.value < filters.minProjectedNetYieldPercent) return false;
      } else if (!include) {
        return false;
      }
    }
    return true;
  });
}

/** Narrow the list by free-text search (kept separate so it can run on every keystroke). */
export function applyQuery(markets: readonly MarketSummaryDto[], query: string): MarketSummaryDto[] {
  if (query.trim() === '') return [...markets];
  return markets.filter((market) => matchesQuery(market, query));
}
