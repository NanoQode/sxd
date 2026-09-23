import 'server-only';
import type { ComparisonResponse, EvidenceBadge, ScenarioAssumptions } from '@simplexd/contracts';
import { comparisonRequestSchema } from '@simplexd/contracts';
import { getDb, withActor, type DbExecutor } from '@simplexd/db';
import { compareMarkets, type ComparisonResult, type Objective } from '@simplexd/domain/ranking';
import { formatDate } from '@simplexd/domain/time';
import type { z } from 'zod';
import type { RequestIdentity } from '@/lib/auth/session';
import { visibilityFor } from './access';
import { mergeInputSet, runInputSet } from './calculators';
import { observationBadge, observationDate, observationFreshness } from './evidence';
import { GEOGRAPHIC_SCOPE_LABELS } from '@simplexd/domain/ranking';
import { METRIC_LABELS } from './metric-map';
import { loadPolicyContext, type PolicyContext } from './policy';
import { prepareMarkets } from './ranking-adapter';
import { loadRankableBundles } from './recommendations';
import type { MarketBundle, ObservationRecord } from './types';

export type ComparisonRequest = z.infer<typeof comparisonRequestSchema>;

type Row = ComparisonResponse['rows'][number];
type Cell = Row['cells'][number];

const ASSUMPTION_LABEL = 'your assumption';

function metricRows(result: ComparisonResult): Row[] {
  return result.rows.map((row) => ({
    metric: row.metric,
    label: `${METRIC_LABELS[row.metric]} (${row.unit}, ${row.direction === 'lower_is_better' ? 'lower is better' : 'higher is better'})`,
    cells: row.cells.map((cell): Cell => ({
      marketId: cell.marketId,
      value: cell.value,
      unit: cell.unit,
      badge: cell.badge,
      evidenceDate: cell.evidenceDate,
      confidence: cell.confidence,
      geographicScope: cell.geographicScope,
      label: !cell.present
        ? null
        : cell.badge === 'user_assumption' || cell.badge === 'model_estimate'
          ? ASSUMPTION_LABEL
          : (cell.geographicScope ?? null),
    })),
  }));
}

function humanise(metric: string): string {
  return metric.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function contextCell(
  marketId: string,
  record: ObservationRecord | undefined,
  policy: PolicyContext,
): Cell {
  if (!record) {
    return {
      marketId,
      value: null,
      unit: null,
      badge: 'unknown' satisfies EvidenceBadge,
      evidenceDate: null,
      confidence: null,
      geographicScope: null,
      label: null,
    };
  }
  const freshness = observationFreshness(record, policy.policies, policy.asOf);
  const scope = GEOGRAPHIC_SCOPE_LABELS[record.observation.geographyLevel];
  const value =
    record.observation.valueNumeric === null ? null : Number(record.observation.valueNumeric);
  return {
    marketId,
    value: Number.isFinite(value) ? value : null,
    unit: record.observation.unit,
    badge: observationBadge(record, freshness),
    evidenceDate: observationDate(record.observation),
    confidence: null,
    geographicScope: scope,
    label: scope,
  };
}

/**
 * Context rows: every observation metric any compared market carries, one
 * cell per market. A local row wins; otherwise the statewide context row is
 * shown and labelled as such, never presented as a city value.
 */
function contextRows(bundles: readonly MarketBundle[], policy: PolicyContext): Row[] {
  const metrics = new Set<string>();
  for (const b of bundles)
    for (const r of [...b.local, ...b.regional]) metrics.add(r.observation.metric);
  const newest = (records: ObservationRecord[]): ObservationRecord | undefined =>
    [...records].sort((a, b) =>
      (observationDate(b.observation) ?? '').localeCompare(observationDate(a.observation) ?? ''),
    )[0];
  return [...metrics].sort().map((metric) => ({
    metric: `context:${metric}`,
    label: `${humanise(metric)} (context; statewide rows are labelled and are not city values)`,
    cells: bundles.map((b) => {
      const local = newest(b.local.filter((r) => r.observation.metric === metric));
      const regional = newest(b.regional.filter((r) => r.observation.metric === metric));
      return contextCell(b.market.id, local ?? regional, policy);
    }),
  }));
}

function overlapWarnings(result: ComparisonResult, bundles: readonly MarketBundle[]) {
  if (!result.overlapWarning) return [];
  const nameOf = (id: string): string => bundles.find((b) => b.market.id === id)?.market.name ?? id;
  return result.overlapWarning.pairs.map(([a, b]) => ({
    marketIds: [a, b],
    message: `${nameOf(a)} and ${nameOf(b)} overlap geographically: overlapping populations, listings and demand totals must not be summed.`,
  }));
}

function calculatorRuns(
  bundles: readonly MarketBundle[],
  assumptions: ScenarioAssumptions | null,
  objective: Objective,
  asOf: Date,
): ComparisonResponse['calculators'] {
  if (!assumptions) return [];
  const sets: Array<['low' | 'base' | 'high', ScenarioAssumptions['base'] | null]> = [
    ['low', assumptions.low ? mergeInputSet(assumptions.base, assumptions.low) : null],
    ['base', assumptions.base],
    ['high', assumptions.high ? mergeInputSet(assumptions.base, assumptions.high) : null],
  ];
  return bundles.flatMap((b) =>
    sets.flatMap(([set, input]) =>
      input
        ? [{ marketId: b.market.id, set, result: runInputSet(input, set, objective, asOf) }]
        : [],
    ),
  );
}

export async function runComparisonIn(
  tx: DbExecutor,
  request: ComparisonRequest,
  identity: RequestIdentity,
  asOf: Date,
): Promise<ComparisonResponse> {
  const policy = await loadPolicyContext(tx, asOf);
  const ordered = [...new Set(request.marketIds)];
  const loaded = await loadRankableBundles(tx, ordered, visibilityFor(identity));
  // Keep the caller's order: cells are positional.
  const bundles = ordered
    .map((id) => loaded.find((b) => b.market.id === id))
    .filter((b): b is MarketBundle => b !== undefined);
  const prepared = prepareMarkets({
    bundles,
    policy,
    asOf,
    request: {
      objective: request.objective,
      mode: request.mode,
      filters: {},
      priorities: request.priorities,
      assumptions: request.assumptions,
      rank: true,
      budgetCeiling: null,
    },
  });
  const result = compareMarkets(prepared.marketInputs, policy.policy, prepared.options);
  const names = bundles.map((b) => b.market.name).join(' vs ');
  return {
    policyVersion: result.policyVersion,
    markets: bundles.map((b) => ({
      marketId: b.market.id,
      slug: b.market.slug,
      name: b.market.name,
      stateName: b.state.name,
      parentMarketId: b.market.parentMarketId,
    })),
    rows: [...metricRows(result), ...contextRows(bundles, policy)],
    overlapWarnings: overlapWarnings(result, bundles),
    calculators: calculatorRuns(bundles, request.assumptions, request.objective, asOf),
    generatedAt: asOf.toISOString(),
    reportTitle: `Market comparison: ${names} (${formatDate(asOf)})`,
  };
}

/** POST /api/v1/comparisons: up to four markets side by side, nothing persisted. */
export async function runComparison(
  request: ComparisonRequest,
  identity: RequestIdentity,
): Promise<ComparisonResponse> {
  const asOf = new Date();
  return withActor(getDb(), identity.ctx, (tx) => runComparisonIn(tx, request, identity, asOf));
}

export { comparisonRequestSchema };
