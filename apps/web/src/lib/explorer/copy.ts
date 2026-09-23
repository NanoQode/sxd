import type {
  ExplorerFilters,
  MetricKey,
  Objective,
  Priorities,
  RankedMarketDto,
  RecommendationResponse,
} from '@simplexd/contracts';
import type { FloodStatus } from './types';
import { DEFAULT_FILTERS, type Zone } from './url-state';

/**
 * Wording shared by the explorer components. Kept in one place so tests can
 * assert the exact phrases the brief requires ("More local data needed",
 * "Unable to assess", "statewide context", never a generic "Verified").
 */

export const COPY = {
  moreLocalData: 'More local data needed',
  compareWithAssumptions: 'Compare with assumptions instead',
  unableToAssess: 'Unable to assess: no flood or title evidence yet',
  statewideContext: 'Statewide context — not a city value',
  scenarioDisclaimer:
    'All calculators are scenarios under your assumptions, not valuations, guarantees or investment advice.',
  notPromisedDate:
    'This is a scenario schedule under your assumptions, not a promised completion date.',
  mapNotConfigured: 'Map tiles are not configured yet',
  mapNotConfiguredDetail:
    'A licensed map tile provider has not been connected (NEXT_PUBLIC_MAP_STYLE_URL). The list below has the complete functionality of the map.',
  mapFailed: 'The map could not be loaded',
  noTenders:
    'No tender opportunities are published publicly for this market. Tenders are invitation-based: invited partners see open tenders in their partner workspace after signing in, and customers see their own organisation’s tenders.',
  noTendersForYou: 'No open tender opportunities for this market are visible to you right now.',
  tendersModuleOff: 'Tendering is not enabled for this deployment or your account yet.',
  noSupplierQuotes:
    'No verified supplier quotations yet. Leads below are research pointers, not delivery routes or prices.',
  coverageVsAvailability:
    'Map coverage and service availability are separate: a marker does not mean a staffed SimplexD operation.',
  denominatorNote:
    'Yields divide by the development cost (the denominator), not by a market value.',
  paybackUndefined: 'undefined (non-positive cash flow)',
  assumptionModeBanner:
    'Assumption mode: your inputs and model estimates count. Results are scenarios, not evidence-backed rankings.',
  evidenceModeHint: 'Evidence mode: only sourced, fresh, locally applicable observations count.',
} as const;

export const OBJECTIVE_LABELS: Record<Objective, string> = {
  owner_occupation: 'Owner occupation',
  long_term_rent: 'Long-term rental',
  development_for_sale: 'Development for sale',
  student_housing: 'Student housing',
  commercial: 'Commercial',
  short_stay: 'Short stay',
};

export const ZONE_LABELS: Record<Zone, string> = {
  NC: 'North Central',
  NE: 'North East',
  NW: 'North West',
  SE: 'South East',
  SS: 'South South',
  SW: 'South West',
};

export const METRIC_LABELS: Record<MetricKey, string> = {
  affordability: 'Affordability',
  material_access: 'Material delivery and access',
  net_rental_economics: 'Net rental economics',
  construction_duration: 'Construction duration',
  approval_duration: 'Approval duration',
  evidence_backed_demand: 'Evidence-backed demand',
  infrastructure_site_suitability: 'Infrastructure and site suitability',
};

/** Proposed product defaults from the brief (§6.3); not researched investment truths. */
export const DEFAULT_WEIGHT_PERCENT: Record<MetricKey, number> = {
  affordability: 25,
  material_access: 15,
  net_rental_economics: 20,
  construction_duration: 10,
  approval_duration: 10,
  evidence_backed_demand: 10,
  infrastructure_site_suitability: 10,
};

export const AVAILABILITY_LABELS: Record<string, string> = {
  pending_operations_confirmation: 'Service availability pending confirmation',
  available: 'Service team available',
  limited: 'Limited service availability',
  on_request: 'Service on request',
  unavailable: 'No service team yet',
};

export const FRESHNESS_LEGEND: Record<'fresh' | 'stale' | 'unknown', string> = {
  fresh: 'Fresh local evidence',
  stale: 'Stale evidence only',
  unknown: 'No local evidence yet',
};

export const FLOOD_LABELS: Record<FloodStatus, string> = {
  unknown: COPY.unableToAssess,
  low: 'Flood exposure assessed as low',
  moderate: 'Flood exposure assessed as moderate',
  high: 'Flood exposure assessed as high',
  official_alert: 'Official flood alert in force',
};

export function humanizeKey(value: string): string {
  return value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function metricLabel(metric: string): string {
  return (METRIC_LABELS as Record<string, string>)[metric] ?? humanizeKey(metric);
}

export interface StatusSummary {
  tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info';
  label: string;
  detail: string | null;
}

/** How a market's ranking status is worded in the list and panel. */
export function statusSummary(
  ranked: RankedMarketDto | null,
  recommendation: Pick<RecommendationResponse, 'rankingEnabled' | 'rankingDisabledReason'> | null,
): StatusSummary {
  if (!ranked) {
    return {
      tone: 'neutral',
      label: 'Not ranked',
      detail: recommendation?.rankingDisabledReason ?? null,
    };
  }
  switch (ranked.status) {
    case 'ranked':
      return {
        tone: 'success',
        label: `Ranked #${ranked.rank ?? '—'}`,
        detail: `Fit ${formatScore(ranked.fit)} · coverage ${formatCoverage(ranked.coverage)}`,
      };
    case 'scored':
      return {
        tone: 'info',
        label: ranked.assumptionFit !== null ? 'Scored on assumptions' : 'Screened, not ranked',
        detail:
          ranked.assumptionFit !== null
            ? `Assumption fit ${formatScore(ranked.assumptionFit)} · coverage ${formatCoverage(ranked.coverage)}`
            : `Coverage ${formatCoverage(ranked.coverage)}`,
      };
    case 'more_local_data_needed':
      return {
        tone: 'warning',
        label: COPY.moreLocalData,
        detail:
          ranked.missing.length > 0
            ? `Missing: ${ranked.missing.map(metricLabel).join(', ')}`
            : null,
      };
    case 'excluded':
      return {
        tone: 'danger',
        label: 'Excluded',
        detail: ranked.exclusionReason ? humanizeKey(ranked.exclusionReason) : null,
      };
  }
}

export function formatScore(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${Math.round(value)}/100`;
}

export function formatCoverage(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${Math.round(value * 100)}%`;
}

export function formatConfidence(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${Math.round(value * 100)}%`;
}

/** Effective priorities (0–1 per metric) with the brief's defaults where unset. */
export function priorityOrDefault(priorities: Priorities, metric: MetricKey): number {
  const value = priorities[metric];
  return typeof value === 'number' ? value : 1;
}

const FILTER_LABELS: Record<keyof ExplorerFilters, string> = {
  objective: 'Objective',
  totalBudgetNaira: 'Total budget (₦)',
  landAreaM2: 'Land area (m²)',
  floorAreaM2: 'Floor area (m²)',
  assetType: 'Asset type',
  bedroomsOrUnits: 'Bedrooms or units',
  qualitySpecification: 'Quality specification',
  targetCompletionMonths: 'Target completion (months)',
  minProjectedNetYieldPercent: 'Minimum projected net yield (%)',
  preferredZones: 'Preferred regions',
  preferredStateIds: 'Preferred states',
  riskTolerance: 'Risk tolerance',
  evidenceFreshness: 'Evidence freshness',
  includeUnknown: 'Include unknown',
  power: 'Power',
  water: 'Water',
  internet: 'Internet',
  transport: 'Transport',
  schools: 'Schools',
  hospitals: 'Hospitals',
  floodExposure: 'Flood exposure',
  soilInvestigation: 'Soil investigation',
  serviceTeamAvailability: 'Service team availability',
};

/** "Label: value" lines for every filter that differs from its default (objective always listed). */
export function describeFilters(
  filters: ExplorerFilters,
  stateNames: ReadonlyMap<string, string> = new Map(),
): string[] {
  const lines: string[] = [];
  for (const key of Object.keys(FILTER_LABELS) as Array<keyof ExplorerFilters>) {
    const value = filters[key];
    const fallback = DEFAULT_FILTERS[key];
    const isDefault = Array.isArray(value)
      ? Array.isArray(fallback) && value.length === fallback.length
      : value === fallback;
    if (isDefault && key !== 'objective') continue;
    let text: string;
    if (key === 'objective') text = OBJECTIVE_LABELS[filters.objective];
    else if (key === 'preferredZones')
      text = filters.preferredZones.map((z) => ZONE_LABELS[z]).join(', ');
    else if (key === 'preferredStateIds')
      text = filters.preferredStateIds.map((id) => stateNames.get(id) ?? id).join(', ');
    else if (typeof value === 'boolean') text = value ? 'Yes' : 'No';
    else if (typeof value === 'number') text = value.toLocaleString('en-NG');
    else text = humanizeKey(String(value));
    lines.push(`${FILTER_LABELS[key]}: ${text}`);
  }
  return lines;
}

export function describePriorities(priorities: Priorities): string {
  const entries = Object.entries(priorities).filter(([, v]) => typeof v === 'number' && v !== 1);
  if (entries.length === 0) return 'Default priorities';
  return entries
    .map(
      ([k, v]) =>
        `${metricLabel(k)} ×${(v as number).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`,
    )
    .join(', ');
}
