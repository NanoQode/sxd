/**
 * Ranking a list of markets.
 *
 * Brief (quoted): "Rank by eligible fit, then confidence, then a stable identifier. Explain the top
 * contributing metrics." and "Sponsored placements must be separate, labeled and cannot alter fit
 * scores."
 */

import { assertUniqueIds, prepareRanking, scoreMarket } from './scoring';
import type {
  MarketInput,
  RankingOptions,
  RankingPolicy,
  RankingResult,
  ScoredMarket,
} from './types';

export const SPONSORED_LABEL = 'Sponsored';

type OrderingBasis = RankingResult['orderedBy'];

/** Plain code-unit comparison: deterministic and locale-independent. */
export function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function orderingFit(market: ScoredMarket, basis: OrderingBasis): number | null {
  return basis === 'fit' ? market.fit : market.assumptionFit;
}

function orderingConfidence(market: ScoredMarket, basis: OrderingBasis): number {
  const value = basis === 'fit' ? market.confidence : (market.assumption?.confidence ?? null);
  return value ?? 0;
}

/**
 * Fit desc, then confidence (mean c over eligible metrics) desc, then id asc. Markets without a fit
 * on the ordering basis follow, by id.
 */
export function createOrderComparator(
  basis: OrderingBasis,
): (a: ScoredMarket, b: ScoredMarket) => number {
  return (a, b) => {
    const fitA = orderingFit(a, basis);
    const fitB = orderingFit(b, basis);
    if (fitA !== null || fitB !== null) {
      if (fitA === null) return 1;
      if (fitB === null) return -1;
      if (fitA !== fitB) return fitB - fitA;
      const confidenceA = orderingConfidence(a, basis);
      const confidenceB = orderingConfidence(b, basis);
      if (confidenceA !== confidenceB) return confidenceB - confidenceA;
    }
    return compareIds(a.id, b.id);
  };
}

/**
 * Ranks markets deterministically under a versioned policy.
 *
 * - `organic`: every non-excluded market, ordered purely on merit. A sponsored market that earns a
 *   position keeps it; sponsorship neither adds, removes nor moves an organic entry.
 * - `sponsored`: the sponsored markets again, as labelled placements with the same figures.
 * - `excluded`: markets removed by a hard constraint, with the reason.
 *
 * In evidence mode the list is ordered by `fit`; in assumption mode by `assumptionFit`, the
 * visibly separate scenario figure.
 */
export function rankMarkets(
  markets: readonly MarketInput[],
  policy: RankingPolicy,
  options: RankingOptions,
): RankingResult {
  const ctx = prepareRanking(policy, options);
  assertUniqueIds(markets);
  const scored = markets.map((market) => scoreMarket(market, ctx));
  const orderedBy: OrderingBasis = ctx.mode === 'assumption' ? 'assumptionFit' : 'fit';
  const compare = createOrderComparator(orderedBy);

  let position = 0;
  const organic: ScoredMarket[] = scored
    .filter((market) => market.status !== 'excluded')
    .sort(compare)
    .map((market) => {
      const rank = orderingFit(market, orderedBy) === null ? null : (position += 1);
      return { ...market, rank, placement: 'organic', label: null };
    });
  const sponsored: ScoredMarket[] = organic
    .filter((market) => market.sponsored)
    .map((market) => ({ ...market, placement: 'sponsored', label: SPONSORED_LABEL }));
  const excluded: ScoredMarket[] = scored
    .filter((market) => market.status === 'excluded')
    .sort((a, b) => compareIds(a.id, b.id));

  return {
    policyVersion: policy.version,
    asOf: options.asOf,
    objective: options.objective,
    mode: ctx.mode,
    rankingRequested: ctx.rank,
    orderedBy,
    coverageThreshold: ctx.coverageThreshold,
    effectiveWeights: ctx.effectiveWeights,
    omittedMetrics: ctx.omittedMetrics,
    disabledMetrics: ctx.disabledMetrics,
    priorityOverrides: ctx.appliedOverrides,
    policyErrors: ctx.policyErrors,
    organic,
    sponsored,
    excluded,
  };
}
