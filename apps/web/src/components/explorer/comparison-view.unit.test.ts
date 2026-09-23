import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import type { ReactElement } from 'react';

/** SSR inserts comment markers between adjacent text nodes; strip them for substring assertions. */
const renderToString = (element: ReactElement): string =>
  renderRaw(element).replace(/<!-- -->/g, '');
import type { ComparisonResponse } from '@simplexd/contracts';
import { COPY } from '@/lib/explorer';
import { uuid } from '@/lib/explorer/test-fixtures';
import { ComparisonTable } from './comparison-view';

describe('ComparisonTable', () => {
  it('shows units, evidence dates, confidence and statewide labels; unknown stays unknown', () => {
    const lagos = uuid(1);
    const kano = uuid(2);
    const comparison: ComparisonResponse = {
      policyVersion: 3,
      markets: [
        { marketId: lagos, slug: 'lagos', name: 'Lagos', stateName: 'Lagos', parentMarketId: null },
        { marketId: kano, slug: 'kano', name: 'Kano', stateName: 'Kano', parentMarketId: null },
      ],
      rows: [
        {
          metric: 'net_rental_economics',
          label: 'Median annual asking rent',
          cells: [
            {
              marketId: lagos,
              value: 14_000_000,
              unit: 'NGN/year',
              badge: 'regional_context',
              evidenceDate: '2026-09-21',
              confidence: 0.42,
              geographicScope: 'statewide context',
              label: null,
            },
            {
              marketId: kano,
              value: null,
              unit: 'NGN/year',
              badge: 'unknown',
              evidenceDate: null,
              confidence: null,
              geographicScope: null,
              label: null,
            },
          ],
        },
      ],
      overlapWarnings: [],
      calculators: [],
      generatedAt: '2026-09-23T10:00:00.000Z',
      reportTitle: 'Comparison',
    };
    const html = renderToString(createElement(ComparisonTable, { comparison }));
    expect(html).toContain('₦14,000,000 /year');
    expect(html).toContain('Evidence 21 Sep 2026');
    expect(html).toContain('confidence 42%');
    expect(html).toContain(COPY.statewideContext);
    expect(html).toContain('Unknown');
    expect(html).toContain('Undated');
    expect(html).toContain('policy version 3');
    expect(html).not.toContain('₦0');
  });
});
