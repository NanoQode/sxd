import type {
  MarketSummaryDto,
  RankedMarketDto,
  RecommendationResponse,
} from '@simplexd/contracts';
import type { MarketRow, MarketRows } from './types';

/**
 * Merges market summaries with a recommendation response into list rows.
 * Sponsored placements are kept apart and never influence the organic order;
 * excluded markets are listed separately with their reason.
 */

const byName = (a: MarketRow, b: MarketRow): number =>
  a.market.name.localeCompare(b.market.name, 'en') || a.market.slug.localeCompare(b.market.slug);

/** Rank ascending (unranked last), then fit descending, then confidence, then name. */
export function compareRows(a: MarketRow, b: MarketRow): number {
  const ra = a.ranked?.rank ?? null;
  const rb = b.ranked?.rank ?? null;
  if (ra !== null && rb !== null && ra !== rb) return ra - rb;
  if (ra !== null && rb === null) return -1;
  if (ra === null && rb !== null) return 1;
  const fa = a.ranked?.fit ?? a.ranked?.assumptionFit ?? null;
  const fb = b.ranked?.fit ?? b.ranked?.assumptionFit ?? null;
  if (fa !== null && fb !== null && fa !== fb) return fb - fa;
  if (fa !== null && fb === null) return -1;
  if (fa === null && fb !== null) return 1;
  const ca = a.ranked?.confidence ?? null;
  const cb = b.ranked?.confidence ?? null;
  if (ca !== null && cb !== null && ca !== cb) return cb - ca;
  return byName(a, b);
}

/** Index every ranked market (organic, sponsored and excluded) by slug. */
export function rankedIndex(
  recommendation: RecommendationResponse | null | undefined,
): Map<string, RankedMarketDto> {
  const index = new Map<string, RankedMarketDto>();
  if (!recommendation) return index;
  for (const list of [recommendation.organic, recommendation.sponsored, recommendation.excluded]) {
    for (const ranked of list) index.set(ranked.slug, ranked);
  }
  return index;
}

export function buildRows(
  markets: readonly MarketSummaryDto[],
  recommendation: RecommendationResponse | null | undefined,
): MarketRows {
  const organic: MarketRow[] = [];
  const sponsored: MarketRow[] = [];
  const excluded: MarketRow[] = [];
  if (!recommendation) {
    for (const market of markets) organic.push({ market, ranked: null, placement: 'organic' });
    organic.sort(byName);
    return { organic, sponsored, excluded };
  }
  const sponsoredSlugs = new Set(recommendation.sponsored.map((r) => r.slug));
  const excludedSlugs = new Set(recommendation.excluded.map((r) => r.slug));
  const index = rankedIndex(recommendation);
  for (const market of markets) {
    const ranked = index.get(market.slug) ?? null;
    if (excludedSlugs.has(market.slug)) {
      excluded.push({ market, ranked, placement: 'excluded' });
    } else if (sponsoredSlugs.has(market.slug)) {
      sponsored.push({ market, ranked, placement: 'sponsored' });
    } else {
      organic.push({ market, ranked, placement: 'organic' });
    }
  }
  organic.sort(compareRows);
  sponsored.sort(compareRows);
  excluded.sort(byName);
  return { organic, sponsored, excluded };
}

/** True when the response actually ranked at least one market. */
export function hasRanking(recommendation: RecommendationResponse | null | undefined): boolean {
  return Boolean(
    recommendation?.rankingEnabled &&
      recommendation.organic.some((r) => r.status === 'ranked' && r.rank !== null),
  );
}
