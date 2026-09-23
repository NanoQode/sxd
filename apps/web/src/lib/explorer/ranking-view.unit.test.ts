import { describe, expect, it } from 'vitest';
import { COPY, statusSummary } from './copy';
import { buildRows, hasRanking, rankedIndex } from './ranking-view';
import { market, ranked, recommendation } from './test-fixtures';

describe('buildRows', () => {
  const abuja = market({ slug: 'abuja', name: 'Abuja' });
  const lagos = market({ slug: 'lagos', name: 'Lagos' });
  const kano = market({ slug: 'kano', name: 'Kano' });
  const zaria = market({ slug: 'zaria', name: 'Zaria' });
  const markets = [zaria, lagos, kano, abuja];

  it('sorts by name when there is no recommendation', () => {
    const rows = buildRows(markets, null);
    expect(rows.organic.map((r) => r.market.slug)).toEqual(['abuja', 'kano', 'lagos', 'zaria']);
    expect(rows.sponsored).toEqual([]);
    expect(rows.excluded).toEqual([]);
  });

  it('orders ranked markets by rank, keeps sponsored apart and lists exclusions with reasons', () => {
    const rec = recommendation({
      organic: [
        ranked({
          slug: 'lagos',
          name: 'Lagos',
          marketId: lagos.id,
          status: 'ranked',
          rank: 2,
          fit: 61,
          coverage: 0.8,
        }),
        ranked({
          slug: 'kano',
          name: 'Kano',
          marketId: kano.id,
          status: 'ranked',
          rank: 1,
          fit: 70,
          coverage: 0.9,
        }),
        ranked({
          slug: 'zaria',
          name: 'Zaria',
          marketId: zaria.id,
          status: 'more_local_data_needed',
        }),
      ],
      sponsored: [
        ranked({
          slug: 'abuja',
          name: 'Abuja',
          marketId: abuja.id,
          status: 'ranked',
          rank: 1,
          fit: 90,
        }),
      ],
      excluded: [],
    });
    const rows = buildRows(markets, rec);
    expect(rows.organic.map((r) => r.market.slug)).toEqual(['kano', 'lagos', 'zaria']);
    expect(rows.sponsored.map((r) => r.market.slug)).toEqual(['abuja']);
    expect(hasRanking(rec)).toBe(true);
    expect(rankedIndex(rec).get('abuja')?.fit).toBe(90);

    const withExclusion = recommendation({
      ...rec,
      excluded: [
        ranked({
          slug: 'zaria',
          name: 'Zaria',
          marketId: zaria.id,
          status: 'excluded',
          exclusionReason: 'over_budget',
        }),
      ],
    });
    const rows2 = buildRows(markets, withExclusion);
    expect(rows2.excluded.map((r) => r.market.slug)).toEqual(['zaria']);
    expect(rows2.organic.map((r) => r.market.slug)).toEqual(['kano', 'lagos']);
  });

  it('reports no ranking when the policy disabled it', () => {
    const rec = recommendation({
      rankingEnabled: false,
      rankingDisabledReason: 'Default financial ranking is disabled until local evidence exists.',
      organic: [ranked({ slug: 'lagos', name: 'Lagos', marketId: lagos.id })],
    });
    expect(hasRanking(rec)).toBe(false);
    // Nothing is ranked, so the list falls back to alphabetical order.
    expect(buildRows(markets, rec).organic.map((r) => r.market.slug)).toEqual([
      'abuja',
      'kano',
      'lagos',
      'zaria',
    ]);
  });
});

describe('statusSummary wording', () => {
  it('uses the brief phrases for each status', () => {
    expect(
      statusSummary(null, { rankingEnabled: false, rankingDisabledReason: 'off' }),
    ).toMatchObject({
      label: 'Not ranked',
      detail: 'off',
    });
    const more = statusSummary(ranked({ slug: 'a', name: 'A', marketId: 'x' }), null);
    expect(more.label).toBe(COPY.moreLocalData);
    expect(more.detail).toContain('Missing:');
    const rankedRow = statusSummary(
      ranked({
        slug: 'a',
        name: 'A',
        marketId: 'x',
        status: 'ranked',
        rank: 3,
        fit: 55.4,
        coverage: 0.75,
      }),
      null,
    );
    expect(rankedRow.label).toBe('Ranked #3');
    expect(rankedRow.detail).toBe('Fit 55/100 · coverage 75%');
    const excluded = statusSummary(
      ranked({
        slug: 'a',
        name: 'A',
        marketId: 'x',
        status: 'excluded',
        exclusionReason: 'over_budget',
      }),
      null,
    );
    expect(excluded).toMatchObject({ label: 'Excluded', detail: 'Over budget' });
  });
});
