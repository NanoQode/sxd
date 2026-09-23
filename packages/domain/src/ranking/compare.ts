/**
 * Side-by-side comparison of up to four markets.
 *
 * Brief (quoted): "Comparisons show underlying units, evidence dates, confidence and geographic
 * scope. A statewide observation must be labeled statewide context, not silently presented as a
 * city value. Lagos metro overlaps Ikeja/Ikorodu; do not add overlapping populations, listings or
 * demand totals."
 */

import { compareIds } from './rank';
import { assertUniqueIds, prepareRanking, scoreMarket } from './scoring';
import type {
  ComparisonCell,
  ComparisonMarketSummary,
  ComparisonResult,
  ComparisonRow,
  GeographicScopeLabel,
  MarketInput,
  MetricDetail,
  MetricKey,
  OverlapWarning,
  RankingOptions,
  RankingPolicy,
  ScoredMarket,
} from './types';

export const MAX_COMPARED_MARKETS = 4;

export const OVERLAP_MESSAGE =
  'overlapping populations, listings and demand totals must not be summed.';

function toCell(market: ScoredMarket, detail: MetricDetail | undefined): ComparisonCell {
  return {
    marketId: market.id,
    present: detail?.present ?? false,
    badge: detail?.badge ?? 'unknown',
    value: detail?.value ?? null,
    unit: detail?.unit ?? null,
    evidenceDate: detail?.evidenceDate ?? null,
    validUntil: detail?.validUntil ?? null,
    freshness: detail?.freshness ?? null,
    confidence: detail?.confidence ?? null,
    geographicLevel: detail?.geographicLevel ?? null,
    geographicScope: detail?.geographicScope ?? null,
    score: detail?.score ?? null,
    evidenceEligible: detail?.evidenceEligible ?? false,
    assumptionEligible: detail?.assumptionEligible ?? false,
    ineligibilityReasons: detail?.ineligibilityReasons ?? [],
  };
}

function summarise(market: ScoredMarket): ComparisonMarketSummary {
  return {
    id: market.id,
    name: market.name,
    status: market.status,
    exclusionReason: market.exclusionReason,
    fit: market.fit,
    assumptionFit: market.assumptionFit,
    coverage: market.coverage,
    confidence: market.confidence,
    missing: market.missing,
    riskAssessment: market.riskAssessment,
    biddingWindowDays: market.biddingWindowDays,
    sponsored: market.sponsored,
  };
}

/** Two markets overlap when they share an overlap group, share a parent, or one is the other's parent. */
export function marketsOverlap(a: MarketInput, b: MarketInput): boolean {
  const groupA = a.overlapGroup ?? '';
  const groupB = b.overlapGroup ?? '';
  if (groupA !== '' && groupA === groupB) return true;
  const parentA = a.parentMarketId ?? null;
  const parentB = b.parentMarketId ?? null;
  if (parentA !== null && parentA === parentB) return true;
  return parentA === b.id || parentB === a.id;
}

/** Overlap warning for a set of markets, or null when no pair overlaps. */
export function detectOverlap(markets: readonly MarketInput[]): OverlapWarning | null {
  const pairs: Array<[string, string]> = [];
  markets.forEach((a, index) => {
    for (const b of markets.slice(index + 1)) {
      if (marketsOverlap(a, b)) {
        pairs.push(compareIds(a.id, b.id) <= 0 ? [a.id, b.id] : [b.id, a.id]);
      }
    }
  });
  if (pairs.length === 0) return null;
  pairs.sort((x, y) => compareIds(x[0], y[0]) || compareIds(x[1], y[1]));
  const described = pairs.map(([x, y]) => `${x} and ${y}`).join('; ');
  return {
    pairs,
    message: `Overlapping markets (${described}): ${OVERLAP_MESSAGE}`,
  };
}

/**
 * Compares up to four markets under the same policy and options as `rankMarkets`, one row per
 * selected metric. Every cell carries the underlying value and unit, evidence date, confidence and
 * geographic scope; `labels[marketId][metric]` is the scope label, 'statewide context' for a
 * state-level observation.
 */
export function compareMarkets(
  markets: readonly MarketInput[],
  policy: RankingPolicy,
  options: RankingOptions,
): ComparisonResult {
  if (markets.length > MAX_COMPARED_MARKETS) {
    throw new RangeError(
      `compareMarkets accepts at most ${MAX_COMPARED_MARKETS} markets, got ${markets.length}`,
    );
  }
  assertUniqueIds(markets);
  const ctx = prepareRanking(policy, options);
  const scored = markets.map((market) => scoreMarket(market, ctx));

  const rows: ComparisonRow[] = ctx.selectedMetrics.map((metric) => {
    const bound = ctx.bounds[metric];
    if (!bound) throw new Error(`internal: selected metric ${metric} has no bound`);
    return {
      metric,
      unit: bound.unit,
      direction: bound.direction,
      weight: ctx.effectiveWeights[metric],
      cells: scored.map((market) =>
        toCell(
          market,
          market.metrics.find((detail) => detail.metric === metric),
        ),
      ),
    };
  });

  const labels: Record<string, Partial<Record<MetricKey, GeographicScopeLabel>>> = {};
  for (const market of scored) {
    const perMetric: Partial<Record<MetricKey, GeographicScopeLabel>> = {};
    for (const detail of market.metrics) {
      if (detail.present && detail.geographicScope)
        perMetric[detail.metric] = detail.geographicScope;
    }
    labels[market.id] = perMetric;
  }

  return {
    policyVersion: policy.version,
    asOf: options.asOf,
    objective: options.objective,
    mode: ctx.mode,
    marketIds: scored.map((market) => market.id),
    markets: scored.map(summarise),
    rows,
    labels,
    overlapWarning: detectOverlap(markets),
    policyErrors: ctx.policyErrors,
  };
}
