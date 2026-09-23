import { describe, expect, it } from 'vitest';
import { MAX_COMPARE, canCompare, marketsOverlap, overlapWarnings, toggleCompare } from './compare';

describe('toggleCompare', () => {
  it('adds, removes and refuses a fifth market', () => {
    expect(toggleCompare([], 'lagos')).toEqual({
      list: ['lagos'],
      added: true,
      removed: false,
      rejected: null,
    });
    expect(toggleCompare(['lagos'], 'lagos').list).toEqual([]);
    const full = ['a', 'b', 'c', 'd'];
    const result = toggleCompare(full, 'e');
    expect(result.rejected).toBe('limit');
    expect(result.list).toEqual(full);
    expect(MAX_COMPARE).toBe(4);
  });

  it('needs two to four markets to compare', () => {
    expect(canCompare(['a'])).toBe(false);
    expect(canCompare(['a', 'b'])).toBe(true);
    expect(canCompare(['a', 'b', 'c', 'd', 'e'])).toBe(false);
  });
});

describe('overlap detection', () => {
  const lagos = {
    id: 'lagos',
    name: 'Lagos',
    parentMarketId: null,
    overlapNote: 'Overlapping metropolitan market labels; do not sum market-level totals.',
  };
  const ikeja = { id: 'ikeja', name: 'Ikeja', parentMarketId: 'lagos', overlapNote: null };
  const ikorodu = { id: 'ikorodu', name: 'Ikorodu', parentMarketId: 'lagos', overlapNote: null };
  const epe = { id: 'epe', name: 'Epe', parentMarketId: null, overlapNote: null };

  it('flags parent/child and shared-parent pairs', () => {
    expect(marketsOverlap(lagos, ikeja)).toBe(true);
    expect(marketsOverlap(ikeja, ikorodu)).toBe(true);
    expect(marketsOverlap(lagos, epe)).toBe(false);
    expect(marketsOverlap(ikeja, epe)).toBe(false);
  });

  it('produces one warning per overlapping pair with the no-summing rule', () => {
    const warnings = overlapWarnings([lagos, ikeja, ikorodu, epe]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('Lagos and Ikeja overlap');
    expect(warnings[0]).toContain('do not sum market-level totals');
    expect(
      warnings.every((w) => w.includes('do not add their populations, listings or demand totals')),
    ).toBe(true);
    expect(overlapWarnings([lagos, epe])).toEqual([]);
  });
});
