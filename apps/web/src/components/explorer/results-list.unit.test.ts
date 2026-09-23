import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import type { ReactElement } from 'react';

/** SSR inserts comment markers between adjacent text nodes; strip them for substring assertions. */
const renderToString = (element: ReactElement): string =>
  renderRaw(element).replace(/<!-- -->/g, '');
import { COPY, buildRows } from '@/lib/explorer';
import { market, ranked, recommendation } from '@/lib/explorer/test-fixtures';
import { ResultsList } from './results-list';

const noop = () => undefined;

describe('ResultsList', () => {
  it('renders "More local data needed" with the missing list and never a price for unknown data', () => {
    const lagos = market({
      slug: 'lagos',
      name: 'Lagos',
      evidence: {
        ...market({ slug: 'x', name: 'x' }).evidence,
        badges: ['regional_context', 'unknown'],
      },
    });
    const rec = recommendation({
      rankingEnabled: false,
      rankingDisabledReason: 'No market has validated local cost and rent evidence yet.',
      organic: [ranked({ slug: 'lagos', name: 'Lagos', marketId: lagos.id })],
    });
    const html = renderToString(
      createElement(ResultsList, {
        rows: buildRows([lagos], rec),
        recommendation: rec,
        selectedSlug: null,
        compareSlugs: [],
        compareFull: false,
        totalCount: 50,
        onSelect: noop,
        onToggleCompare: noop,
        onCompareWithAssumptions: noop,
      }),
    );
    expect(html).toContain(COPY.moreLocalData);
    expect(html).toContain('Missing:');
    expect(html).toContain(COPY.compareWithAssumptions);
    expect(html).toContain('Financial ranking is not active');
    expect(html).toContain('Statewide context');
    expect(html).not.toContain('₦');
    expect(html).toContain('1 of 50 markets match');
  });

  it('keeps sponsored placements in a separate labelled strip and lists exclusions with reasons', () => {
    const a = market({ slug: 'a', name: 'Alpha' });
    const b = market({ slug: 'b', name: 'Beta' });
    const c = market({ slug: 'c', name: 'Gamma' });
    const rec = recommendation({
      organic: [
        ranked({
          slug: 'a',
          name: 'Alpha',
          marketId: a.id,
          status: 'ranked',
          rank: 1,
          fit: 70,
          coverage: 0.8,
        }),
      ],
      sponsored: [
        ranked({ slug: 'b', name: 'Beta', marketId: b.id, status: 'ranked', rank: 1, fit: 99 }),
      ],
      excluded: [
        ranked({
          slug: 'c',
          name: 'Gamma',
          marketId: c.id,
          status: 'excluded',
          exclusionReason: 'over_budget',
        }),
      ],
    });
    const html = renderToString(
      createElement(ResultsList, {
        rows: buildRows([a, b, c], rec),
        recommendation: rec,
        selectedSlug: 'a',
        compareSlugs: ['a', 'b', 'c', 'd'],
        compareFull: true,
        totalCount: 3,
        onSelect: noop,
        onToggleCompare: noop,
      }),
    );
    expect(html).toContain('Sponsored placements');
    expect(html).toContain('never changes a fit score');
    expect(html).toContain('Excluded by your constraints (1)');
    expect(html).toContain('Over budget');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('Remove from comparison');
  });

  it('shows an honest empty state', () => {
    const html = renderToString(
      createElement(ResultsList, {
        rows: { organic: [], sponsored: [], excluded: [] },
        recommendation: null,
        selectedSlug: null,
        compareSlugs: [],
        compareFull: false,
        totalCount: 50,
        onSelect: noop,
        onToggleCompare: noop,
        onResetFilters: noop,
      }),
    );
    expect(html).toContain('No markets match these filters');
    expect(html).toContain('Reset filters');
  });
});
