import type { MarketSummaryDto, RankedMarketDto } from '@simplexd/contracts';

/** Flood status as the explorer reasons about it. `unknown` is never treated as low risk. */
export type FloodStatus = 'unknown' | 'low' | 'moderate' | 'high' | 'official_alert';

/** Whether an optional amenity/site criterion is evidenced for a market. */
export type AmenityStatus = 'present' | 'absent' | 'unknown';

export type Placement = 'organic' | 'sponsored' | 'excluded';

/** A market as shown in the results list: the summary plus its ranking result, if any. */
export interface MarketRow {
  market: MarketSummaryDto;
  ranked: RankedMarketDto | null;
  placement: Placement;
}

export interface MarketRows {
  organic: MarketRow[];
  /** Sponsored placements: always shown in a separate, labelled strip. */
  sponsored: MarketRow[];
  /** Removed by a hard constraint (budget, exclusion, stop flag), with the reason. */
  excluded: MarketRow[];
}

export type ExplorerVariant = 'homepage' | 'full';
