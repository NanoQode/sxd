import { desc, eq } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { schema, type DbExecutor } from '@simplexd/db';
import {
  DEFAULT_COVERAGE_THRESHOLD,
  DEFAULT_FRESHNESS_DAYS,
  parseRankingPolicy,
  type MetricKey,
  type RankingPolicy,
} from '@simplexd/domain/ranking';

/** Freshness window per data type, as configured in `freshness_policies`. */
export interface FreshnessWindow {
  maxAgeDays: number | null;
  respectSourceValidity: boolean;
}

export type FreshnessPolicyMap = ReadonlyMap<string, FreshnessWindow>;

/** Data policy switches the read model reports and the ranking honours. */
export interface DataPolicySettings {
  defaultFinancialRankingEnabled: boolean;
  coverageThreshold: number | null;
}

/** What the list, detail and GeoJSON queries need: freshness rules plus the policy headline. */
export interface ReadModelContext {
  asOf: Date;
  policies: FreshnessPolicyMap;
  activeRankingPolicyVersion: number | null;
  settings: DataPolicySettings;
}

/**
 * Everything the ranking adapter needs, loaded once per request: the active
 * ranking policy (parsed and validated in shape), the freshness windows and
 * the data policy switches.
 */
export interface PolicyContext extends ReadModelContext {
  policy: RankingPolicy;
  policyRowId: string;
  /** Per-metric freshness windows for the engine, derived from the freshness policies. */
  freshnessDays: Record<MetricKey, number | null>;
  coverageThreshold: number;
}

/** Which freshness data type governs each ranking metric. */
const METRIC_FRESHNESS_DATA_TYPE: Record<MetricKey, string | null> = {
  affordability: 'build_rate',
  material_access: 'material_quote',
  net_rental_economics: 'rent_observation',
  construction_duration: null,
  approval_duration: 'observed_permit_performance',
  evidence_backed_demand: null,
  infrastructure_site_suitability: 'official_risk_layer',
};

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function readNumber(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function freshnessDaysFromPolicies(
  freshness: FreshnessPolicyMap,
): Record<MetricKey, number | null> {
  const out = { ...DEFAULT_FRESHNESS_DAYS };
  for (const metric of Object.keys(out) as MetricKey[]) {
    const dataType = METRIC_FRESHNESS_DATA_TYPE[metric];
    if (!dataType) continue;
    const window = freshness.get(dataType);
    if (window) out[metric] = window.maxAgeDays;
  }
  return out;
}

export async function loadFreshnessPolicies(tx: DbExecutor): Promise<FreshnessPolicyMap> {
  const rows = await tx.select().from(schema.freshnessPolicies);
  const map = new Map<string, FreshnessWindow>();
  for (const row of rows) {
    map.set(row.dataType, {
      maxAgeDays: row.maxAgeDays,
      respectSourceValidity: row.respectSourceValidity,
    });
  }
  return map;
}

export async function loadDataPolicySettings(tx: DbExecutor): Promise<DataPolicySettings> {
  const rows = await tx.select().from(schema.dataPolicySettings);
  const value = (key: string): unknown => rows.find((r) => r.key === key)?.value;
  return {
    defaultFinancialRankingEnabled: readBoolean(value('default_financial_ranking_enabled'), false),
    coverageThreshold: readNumber(value('ranking.coverage_threshold')),
  };
}

export async function loadActiveRankingPolicy(
  tx: DbExecutor,
): Promise<{ policy: RankingPolicy; rowId: string } | null> {
  const [row] = await tx
    .select()
    .from(schema.rankingPolicies)
    .where(eq(schema.rankingPolicies.status, 'active'))
    .orderBy(desc(schema.rankingPolicies.version))
    .limit(1);
  if (!row) return null;
  const policy = parseRankingPolicy({
    version: row.version,
    weights: row.weights,
    metricBounds: row.metricBounds,
    confidenceRubric: row.confidenceRubric,
    coverageThreshold: Number(row.coverageThreshold),
    minComparables: row.minComparables,
  });
  return { policy, rowId: row.id };
}

export async function loadReadModelContext(tx: DbExecutor, asOf: Date): Promise<ReadModelContext> {
  const policies = await loadFreshnessPolicies(tx);
  const settings = await loadDataPolicySettings(tx);
  const active = await loadActiveRankingPolicy(tx);
  return {
    asOf,
    policies,
    activeRankingPolicyVersion: active?.policy.version ?? null,
    settings,
  };
}

export async function loadPolicyContext(tx: DbExecutor, asOf: Date): Promise<PolicyContext> {
  const policies = await loadFreshnessPolicies(tx);
  const settings = await loadDataPolicySettings(tx);
  const active = await loadActiveRankingPolicy(tx);
  if (!active) {
    throw new ApiError(
      'provider_not_configured',
      'No active ranking policy is configured; a data approver must activate one before recommendations can run.',
    );
  }
  return {
    asOf,
    policies,
    activeRankingPolicyVersion: active.policy.version,
    settings,
    policy: active.policy,
    policyRowId: active.rowId,
    freshnessDays: freshnessDaysFromPolicies(policies),
    coverageThreshold:
      settings.coverageThreshold ?? active.policy.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD,
  };
}
