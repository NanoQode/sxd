/**
 * Comparison tray logic: up to four markets, and overlap detection for
 * markets that share metropolitan geography (Lagos metro overlaps Ikeja and
 * Ikorodu). Overlapping populations, listings and demand totals must never be
 * summed, so the tray warns whenever two compared markets overlap.
 */

export const MAX_COMPARE = 4;

export interface ToggleResult {
  list: string[];
  added: boolean;
  removed: boolean;
  /** Set when the market could not be added because the tray is full. */
  rejected: 'limit' | null;
}

export function toggleCompare(list: readonly string[], slug: string): ToggleResult {
  if (list.includes(slug)) {
    return { list: list.filter((s) => s !== slug), added: false, removed: true, rejected: null };
  }
  if (list.length >= MAX_COMPARE) {
    return { list: [...list], added: false, removed: false, rejected: 'limit' };
  }
  return { list: [...list, slug], added: true, removed: false, rejected: null };
}

export function canCompare(list: readonly string[]): boolean {
  return list.length >= 2 && list.length <= MAX_COMPARE;
}

export interface OverlapCandidate {
  id: string;
  name: string;
  parentMarketId: string | null;
  overlapNote?: string | null;
}

/** Two markets overlap when one is the other's parent or they share a parent. */
export function marketsOverlap(a: OverlapCandidate, b: OverlapCandidate): boolean {
  if (a.id === b.id) return false;
  if (a.parentMarketId !== null && a.parentMarketId === b.parentMarketId) return true;
  return a.parentMarketId === b.id || b.parentMarketId === a.id;
}

export const OVERLAP_RULE =
  'do not add their populations, listings or demand totals together; treat them as overlapping search areas, not disjoint territories.';

/** One warning per overlapping pair, in the order the markets were given. */
export function overlapWarnings(markets: readonly OverlapCandidate[]): string[] {
  const warnings: string[] = [];
  markets.forEach((a, index) => {
    for (const b of markets.slice(index + 1)) {
      if (!marketsOverlap(a, b)) continue;
      const note = a.overlapNote ?? b.overlapNote ?? null;
      warnings.push(
        `${a.name} and ${b.name} overlap${note ? ` (${note.replace(/\.$/, '')})` : ''}: ${OVERLAP_RULE}`,
      );
    }
  });
  return warnings;
}
