import {
  createParser,
  createSerializer,
  parseAsArrayOf,
  parseAsBoolean,
  parseAsFloat,
  parseAsInteger,
  parseAsString,
  parseAsStringLiteral,
  type inferParserType,
} from 'nuqs';
import {
  explorerFiltersSchema,
  metricKeySchema,
  objectiveSchema,
  type ExplorerFilters,
  type MetricKey,
  type Priorities,
} from '@simplexd/contracts';
import { RESUME_INTENTS } from './resume-intents';

/**
 * URL state for the location explorer. Every filter, the selected market, the
 * comparison list, the mode, the view and the saved scenario live in the query
 * string so deep links, reloads and browser navigation reproduce the same view.
 *
 * Keys are short and stable; defaults are omitted from the URL.
 */

export const OBJECTIVES = objectiveSchema.options;
export const ZONES = ['NC', 'NE', 'NW', 'SE', 'SS', 'SW'] as const;
export const ASSET_TYPES = [
  'land',
  'residential',
  'commercial',
  'industrial',
  'mixed_use',
  'student_housing',
  'short_stay',
] as const;
export const QUALITY_SPECS = ['basic', 'standard', 'premium'] as const;
export const RISK_TOLERANCES = ['low', 'medium', 'high'] as const;
export const EVIDENCE_FRESHNESS = ['fresh_only', 'include_stale'] as const;
export const AMENITY_PREFERENCES = ['required', 'preferred', 'unknown_ok', 'any'] as const;
export const FLOOD_PREFERENCES = ['any', 'low_only', 'exclude_high', 'unknown_ok'] as const;
export const TEAM_PREFERENCES = ['any', 'available_only', 'available_or_on_request'] as const;
export const MODES = ['evidence', 'assumption'] as const;
export const VIEWS = ['map', 'list'] as const;
export const METRIC_KEYS = metricKeySchema.options;

export type Zone = (typeof ZONES)[number];
export type ExplorerMode = (typeof MODES)[number];
export type ExplorerView = (typeof VIEWS)[number];
export type AmenityPreference = (typeof AMENITY_PREFERENCES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID_RE.test(value);

export function isMetricKey(value: string | undefined): value is MetricKey {
  return value !== undefined && (METRIC_KEYS as readonly string[]).includes(value);
}

/* ---------------------------------------------------------------------- */
/* Priorities codec: `affordability:0.5,net_rental_economics:1`             */
/* ---------------------------------------------------------------------- */

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function serializePriorities(priorities: Priorities): string {
  return METRIC_KEYS.filter((key) => typeof priorities[key] === 'number')
    .map((key) => `${key}:${round3(priorities[key] as number)}`)
    .join(',');
}

export function parsePriorities(value: string): Priorities {
  const out: Priorities = {};
  for (const part of value.split(',')) {
    const [key, raw] = part.split(':');
    if (!isMetricKey(key)) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) out[key] = round3(n);
  }
  return out;
}

const parseAsPriorities = createParser<Priorities>({
  parse: (value) => parsePriorities(value),
  serialize: (value) => serializePriorities(value),
  eq: (a, b) => serializePriorities(a) === serializePriorities(b),
});

/* ---------------------------------------------------------------------- */
/* Parsers                                                                 */
/* ---------------------------------------------------------------------- */

const amenity = parseAsStringLiteral(AMENITY_PREFERENCES).withDefault('any');

export const explorerParsers = {
  objective: parseAsStringLiteral(OBJECTIVES).withDefault('long_term_rent'),
  budget: parseAsFloat,
  land: parseAsFloat,
  floor: parseAsFloat,
  asset: parseAsStringLiteral(ASSET_TYPES),
  units: parseAsInteger,
  spec: parseAsStringLiteral(QUALITY_SPECS),
  completion: parseAsInteger,
  yield: parseAsFloat,
  zones: parseAsArrayOf(parseAsStringLiteral(ZONES)).withDefault([]),
  states: parseAsArrayOf(parseAsString).withDefault([]),
  risk: parseAsStringLiteral(RISK_TOLERANCES).withDefault('medium'),
  fresh: parseAsStringLiteral(EVIDENCE_FRESHNESS).withDefault('fresh_only'),
  unknown: parseAsBoolean.withDefault(true),
  power: amenity,
  water: amenity,
  internet: amenity,
  transport: amenity,
  schools: amenity,
  hospitals: amenity,
  soil: amenity,
  flood: parseAsStringLiteral(FLOOD_PREFERENCES).withDefault('any'),
  team: parseAsStringLiteral(TEAM_PREFERENCES).withDefault('any'),
  q: parseAsString.withDefault(''),
  market: parseAsString.withOptions({ history: 'push' }),
  compare: parseAsArrayOf(parseAsString).withDefault([]),
  mode: parseAsStringLiteral(MODES).withDefault('evidence'),
  view: parseAsStringLiteral(VIEWS).withDefault('map').withOptions({ history: 'push' }),
  scenario: parseAsString,
  shared: parseAsString,
  priorities: parseAsPriorities.withDefault({}),
  /** Set when sign-in interrupted an account-gated action; consumed once after the visitor returns. */
  resume: parseAsStringLiteral(RESUME_INTENTS),
};

export type ExplorerParams = inferParserType<typeof explorerParsers>;

export const FILTER_PARAM_KEYS = [
  'objective',
  'budget',
  'land',
  'floor',
  'asset',
  'units',
  'spec',
  'completion',
  'yield',
  'zones',
  'states',
  'risk',
  'fresh',
  'unknown',
  'power',
  'water',
  'internet',
  'transport',
  'schools',
  'hospitals',
  'soil',
  'flood',
  'team',
  'q',
] as const satisfies ReadonlyArray<keyof ExplorerParams>;

export type FilterParamKey = (typeof FILTER_PARAM_KEYS)[number];
export type FilterParams = Pick<ExplorerParams, FilterParamKey>;

const filterParsers = Object.fromEntries(
  FILTER_PARAM_KEYS.map((key) => [key, explorerParsers[key]]),
) as Pick<typeof explorerParsers, FilterParamKey>;

export const serializeExplorer = createSerializer(explorerParsers);
const serializeFilters = createSerializer(filterParsers);

/** Only the filter-related keys of a params object. */
export function pickFilterParams(params: Partial<ExplorerParams>): Partial<FilterParams> {
  const out: Partial<FilterParams> = {};
  for (const key of FILTER_PARAM_KEYS) {
    if (params[key] !== undefined) (out as Record<string, unknown>)[key] = params[key];
  }
  return out;
}

/** True when at least one filter differs from its default (i.e. the URL carries filter state). */
export function hasNonDefaultFilters(params: Partial<ExplorerParams>): boolean {
  return serializeFilters(pickFilterParams(params)) !== '';
}

/** Href for the full explorer carrying the current URL state (used by the homepage variant). */
export function buildExploreHref(
  params: Partial<ExplorerParams>,
  overrides: Partial<ExplorerParams> = {},
  path = '/explore',
): string {
  return serializeExplorer(path, { ...params, ...overrides });
}

/* ---------------------------------------------------------------------- */
/* Filters <-> params                                                      */
/* ---------------------------------------------------------------------- */

export const DEFAULT_FILTERS: ExplorerFilters = explorerFiltersSchema.parse({});

const positiveOrNull = (value: number | null, max: number): number | null =>
  value !== null && Number.isFinite(value) && value > 0 && value <= max ? value : null;

const intInRangeOrNull = (value: number | null, min: number, max: number): number | null =>
  value !== null && Number.isInteger(value) && value >= min && value <= max ? value : null;

const numberInRangeOrNull = (value: number | null, min: number, max: number): number | null =>
  value !== null && Number.isFinite(value) && value >= min && value <= max ? value : null;

/** Builds validated explorer filters from URL params. Invalid values fall back to defaults. */
export function filtersFromParams(params: FilterParams): ExplorerFilters {
  const candidate: ExplorerFilters = {
    objective: params.objective,
    totalBudgetNaira: positiveOrNull(params.budget, 1e13),
    landAreaM2: positiveOrNull(params.land, 1e7),
    floorAreaM2: positiveOrNull(params.floor, 1e6),
    assetType: params.asset,
    bedroomsOrUnits: intInRangeOrNull(params.units, 0, 500),
    qualitySpecification: params.spec,
    targetCompletionMonths: intInRangeOrNull(params.completion, 1, 120),
    minProjectedNetYieldPercent: numberInRangeOrNull(params.yield, 0, 100),
    preferredZones: [...new Set(params.zones)],
    preferredStateIds: [...new Set(params.states.filter(isUuid))],
    riskTolerance: params.risk,
    evidenceFreshness: params.fresh,
    includeUnknown: params.unknown,
    power: params.power,
    water: params.water,
    internet: params.internet,
    transport: params.transport,
    schools: params.schools,
    hospitals: params.hospitals,
    floodExposure: params.flood,
    soilInvestigation: params.soil,
    serviceTeamAvailability: params.team,
  };
  const parsed = explorerFiltersSchema.safeParse(candidate);
  return parsed.success ? parsed.data : DEFAULT_FILTERS;
}

/** Inverse of `filtersFromParams`; used when hydrating the URL from a saved scenario. */
export function paramsFromFilters(filters: ExplorerFilters): FilterParams {
  return {
    objective: filters.objective,
    budget: filters.totalBudgetNaira,
    land: filters.landAreaM2,
    floor: filters.floorAreaM2,
    asset: filters.assetType,
    units: filters.bedroomsOrUnits,
    spec: filters.qualitySpecification,
    completion: filters.targetCompletionMonths,
    yield: filters.minProjectedNetYieldPercent,
    zones: [...filters.preferredZones],
    states: [...filters.preferredStateIds],
    risk: filters.riskTolerance,
    fresh: filters.evidenceFreshness,
    unknown: filters.includeUnknown,
    power: filters.power,
    water: filters.water,
    internet: filters.internet,
    transport: filters.transport,
    schools: filters.schools,
    hospitals: filters.hospitals,
    soil: filters.soilInvestigation,
    flood: filters.floodExposure,
    team: filters.serviceTeamAvailability,
    q: '',
  };
}

/** Number of filters that differ from the defaults (for the "Filters (n)" button). */
export function countActiveFilters(filters: ExplorerFilters): number {
  let count = 0;
  for (const key of Object.keys(DEFAULT_FILTERS) as Array<keyof ExplorerFilters>) {
    const a = filters[key];
    const b = DEFAULT_FILTERS[key];
    const same = Array.isArray(a) && Array.isArray(b) ? a.length === b.length : a === b;
    if (!same) count += 1;
  }
  return count;
}
