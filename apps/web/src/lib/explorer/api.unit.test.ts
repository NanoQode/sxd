import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExplorerApiError,
  describeError,
  getMarketDetail,
  getMarkets,
  getScenarioReport,
  getStates,
  postRecommendations,
  runCalculators,
  snapshotScenario,
} from './api';
import { market, marketDetail, recommendation } from './test-fixtures';

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const mockFetch = (impl: (input: string, init?: RequestInit) => Promise<Response> | Response) => {
  const fn = vi.fn((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init)),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('explorer api client', () => {
  it('parses a valid market list and sends the query string', async () => {
    const fetchSpy = mockFetch(() =>
      jsonResponse({
        items: [market({ slug: 'lagos', name: 'Lagos' })],
        total: 1,
        policy: {
          activeRankingPolicyVersion: null,
          defaultFinancialRankingEnabled: false,
          coverageThreshold: 0.7,
        },
        generatedAt: '2026-09-23T10:00:00.000Z',
      }),
    );
    const result = await getMarkets({ objective: 'commercial' });
    expect(result.items[0]?.slug).toBe('lagos');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toBe('/api/v1/markets?objective=commercial&limit=100');
  });

  it('surfaces the error envelope with code, correlation id and retryability', async () => {
    mockFetch(() =>
      jsonResponse(
        {
          error: {
            code: 'provider_unavailable',
            message: 'Database unavailable',
            correlationId: 'corr-123',
            retryable: true,
          },
        },
        { status: 503 },
      ),
    );
    const error = await getMarkets().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExplorerApiError);
    const described = describeError(error);
    expect(described).toMatchObject({
      code: 'provider_unavailable',
      correlationId: 'corr-123',
      retryable: true,
      status: 503,
    });
  });

  it('turns a contract mismatch into a non-retryable contract error instead of crashing', async () => {
    mockFetch(() => jsonResponse({ items: [{ slug: 'broken' }] }));
    const error = await getMarkets().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExplorerApiError);
    expect((error as ExplorerApiError).kind).toBe('contract');
    expect((error as ExplorerApiError).retryable).toBe(false);
  });

  it('maps a failed fetch to a retryable network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const error = await getMarketDetail('lagos').catch((e: unknown) => e);
    expect((error as ExplorerApiError).kind).toBe('network');
    expect((error as ExplorerApiError).retryable).toBe(true);
  });

  it('accepts both array and {items} shapes for states', async () => {
    mockFetch(() => jsonResponse([{ id: 's1', name: 'Lagos', geopoliticalZone: 'SW' }]));
    expect((await getStates())[0]).toMatchObject({
      name: 'Lagos',
      isFederalCapital: false,
      marketCount: 0,
    });
    mockFetch(() =>
      jsonResponse({ items: [{ id: 's2', name: 'Kano', geopoliticalZone: 'NW', marketCount: 1 }] }),
    );
    expect((await getStates())[0]?.marketCount).toBe(1);
  });

  it('posts recommendations as JSON and validates the response', async () => {
    const fetchSpy = mockFetch(() => jsonResponse(recommendation()));
    const result = await postRecommendations({
      objective: 'long_term_rent',
      mode: 'evidence',
      filters: {},
      priorities: {},
      assumptions: null,
      rank: true,
      budgetCeiling: null,
    });
    expect(result.rankingEnabled).toBe(true);
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body)).objective).toBe('long_term_rent');
  });

  it('normalises calculator responses of unknown key style', async () => {
    mockFetch(() =>
      jsonResponse({
        development_cost: {
          ok: false,
          reason: 'Missing required inputs: land.',
          missing: ['land'],
        },
      }),
    );
    const result = await runCalculators({
      assumptions: { base: {} } as never,
      objective: 'long_term_rent',
      sensitivity: { vacancy: [], rents: [], costs: [], interest: [], completionDelayMonths: [] },
    });
    expect(result.developmentCost).toEqual({
      ok: false,
      reason: 'Missing required inputs: land.',
      missing: ['land'],
    });
  });

  it('reads a snapshot id from either the top level or a nested snapshot', async () => {
    mockFetch(() => jsonResponse({ snapshot: { id: 'snap-1', policyVersion: 3 } }));
    expect(await snapshotScenario('abc')).toMatchObject({ snapshotId: 'snap-1', policyVersion: 3 });
  });

  it('returns a document link when the report is not JSON, and a normalised report when it is', async () => {
    mockFetch(
      () =>
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    expect(await getScenarioReport('abc')).toEqual({
      kind: 'document',
      url: '/api/v1/scenarios/abc/report',
      contentType: 'text/html',
    });
    mockFetch(() =>
      jsonResponse({
        report: {
          title: 'Comparison',
          generatedAt: '2026-09-23T00:00:00Z',
          policyVersion: 2,
          disclaimers: ['Not advice'],
        },
      }),
    );
    const report = await getScenarioReport('abc');
    expect(report).toMatchObject({
      kind: 'json',
      title: 'Comparison',
      policyVersion: 2,
      disclaimers: ['Not advice'],
    });
  });

  it('parses market detail against the contract', async () => {
    mockFetch(() => jsonResponse(marketDetail({ slug: 'lagos', name: 'Lagos' })));
    expect((await getMarketDetail('lagos')).name).toBe('Lagos');
  });
});
