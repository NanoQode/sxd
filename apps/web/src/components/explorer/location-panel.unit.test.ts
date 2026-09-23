import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import type { ReactElement } from 'react';

/** SSR inserts comment markers between adjacent text nodes; strip them for substring assertions. */
const renderToString = (element: ReactElement): string =>
  renderRaw(element).replace(/<!-- -->/g, '');
import { COPY, emptyCalculatorResult } from '@/lib/explorer';
import { marketDetail, observation, ranked, recommendation } from '@/lib/explorer/test-fixtures';
import { LocationPanelContent, TenderOpportunities } from './location-panel';

const noop = () => undefined;

describe('LocationPanelContent', () => {
  it('labels statewide observations, states inability to assess, and includes the required headings', () => {
    const detail = marketDetail({
      slug: 'abeokuta',
      name: 'Abeokuta',
      stateName: 'Ogun',
      regionalContextObservations: [observation({ geographyLabel: 'Ogun' })],
      missingEvidence: ['Local build rate'],
      serviceCoverage: [
        {
          serviceSlug: 'construction-monitoring',
          serviceName: 'Construction monitoring',
          availability: 'on_request',
          note: null,
        },
      ],
    });
    const r = ranked({
      slug: 'abeokuta',
      name: 'Abeokuta',
      marketId: detail.id,
      missingEvidence: ['Local rent evidence'],
    });
    const html = renderToString(
      createElement(LocationPanelContent, {
        detail,
        ranked: r,
        recommendation: recommendation(),
        mode: 'evidence',
        calculators: null,
        compared: false,
        compareFull: false,
        scenarioId: 'scn-1',
        onToggleCompare: noop,
        onSaveScenario: noop,
        onRequestVerification: noop,
        onSwitchToAssumptions: noop,
      }),
    );
    for (const heading of [
      'Why this matches',
      'Missing evidence',
      'Last reviewed',
      'Service coverage',
      'Tender opportunities',
      'Environmental checks',
      'Next actions',
    ]) {
      expect(html).toContain(heading);
    }
    expect(html).toContain(COPY.statewideContext);
    expect(html).toContain('₦14,000,000');
    expect(html).toContain('34,389');
    expect(html).toContain(COPY.unableToAssess);
    // The fixture models a deployment without the tendering module: say so, never invent tenders.
    expect(html).toContain(COPY.tendersModuleOff);
    expect(html).toContain('Local build rate');
    expect(html).toContain('Local rent evidence');
    expect(html).toContain('Not yet reviewed');
    expect(html).toContain(COPY.notPromisedDate);
    expect(html).toContain('/book?market=abeokuta&amp;scenario=scn-1');
    expect(html).toContain(COPY.coverageVsAvailability);
    expect(html).toContain('Service on request');
  });

  it('shows failed calculator reasons instead of numbers in assumption mode', () => {
    const detail = marketDetail({ slug: 'kano', name: 'Kano' });
    const html = renderToString(
      createElement(LocationPanelContent, {
        detail,
        ranked: null,
        recommendation: null,
        mode: 'assumption',
        calculators: emptyCalculatorResult('Missing required inputs: land.'),
        compared: true,
        compareFull: true,
        scenarioId: null,
        onToggleCompare: noop,
        onSaveScenario: noop,
        onRequestVerification: noop,
        onSwitchToAssumptions: noop,
      }),
    );
    expect(html).toContain('Schedule not computed: Missing required inputs: land.');
    expect(html).toContain('Not computed: Missing required inputs: land.');
    expect(html).toContain('/book?market=kano"');
  });
});

describe('TenderOpportunities', () => {
  it('tells anonymous visitors tenders are invitation-based and never lists any', () => {
    const html = renderToString(
      createElement(TenderOpportunities, {
        tenders: { moduleEnabled: true, scope: 'none', items: [] },
      }),
    );
    expect(html).toContain(COPY.noTenders);
    expect(html).not.toContain('/partner/tenders');
  });

  it('shows a signed-in partner their empty state with the workspace link', () => {
    const html = renderToString(
      createElement(TenderOpportunities, {
        tenders: { moduleEnabled: true, scope: 'partner', items: [] },
      }),
    );
    expect(html).toContain(COPY.noTendersForYou);
    expect(html).toContain('href="/partner/tenders"');
  });

  it('lists real open tenders with reference, closing time in the tender time zone and link', () => {
    const html = renderToString(
      createElement(TenderOpportunities, {
        tenders: {
          moduleEnabled: true,
          scope: 'staff',
          items: [
            {
              id: '44444444-4444-4444-8444-444444444444',
              reference: 'TND-2026-0004',
              title: 'Lekki duplex works',
              status: 'clarifications',
              releaseAt: '2026-09-20T08:00:00.000Z',
              submissionDeadlineAt: '2026-10-01T11:00:00.000Z',
              displayTimeZone: 'Africa/Lagos',
              linkedThrough: 'property',
              href: '/admin/tenders/44444444-4444-4444-8444-444444444444',
            },
          ],
        },
      }),
    );
    expect(html).toContain('TND-2026-0004');
    expect(html).toContain('Lekki duplex works');
    expect(html).toContain('closes 1 Oct 2026, 12:00');
    expect(html).toContain('released 20 Sep 2026');
    expect(html).toContain('linked through the project site');
    expect(html).toContain('href="/admin/tenders/44444444-4444-4444-8444-444444444444"');
    expect(html).toContain('never a score');
  });
});
