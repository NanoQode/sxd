import { describe, expect, it, vi } from 'vitest';

/**
 * Crawl controls: the sitemap lists only published public entities, robots
 * disallows every private surface, and location pages without evidence or
 * editorial text are noindex.
 */

vi.mock('@/lib/env', () => ({ env: () => ({ APP_URL: 'https://simplexd.test/' }) }));
vi.mock('@/lib/logger', () => ({ logger: () => ({ warn: () => undefined, info: () => undefined }) }));

const markets = {
  items: [
    { slug: 'lagos', evidence: { lastReviewedAt: '2026-09-01T00:00:00.000Z' } },
    { slug: 'ibadan', evidence: { lastReviewedAt: null } },
  ],
};
vi.mock('@/server/markets/queries', () => ({
  listMarkets: vi.fn(async (query: { includeUnpublished: boolean }) => {
    // The sitemap must ask for published markets only.
    if (query.includeUnpublished) throw new Error('sitemap asked for unpublished markets');
    return markets;
  }),
}));
vi.mock('@/server/services/catalog', () => ({
  listServiceCatalog: vi.fn(async () => ({
    core: [{ slug: 'due-diligence' }],
    planned: [{ slug: 'facility-management' }],
  })),
}));
vi.mock('@/server/content/public', () => ({
  listPublishedContent: vi.fn(async (kind: string) =>
    kind === 'resource'
      ? [{ slug: 'title-checks', publishedAt: '2026-08-01T00:00:00.000Z' }]
      : [{ slug: 'should-not-appear', publishedAt: null }],
  ),
}));
vi.mock('@/server/listings/public', () => ({
  listPublishedListings: vi.fn(async () => [{ slug: 'plot-12', publishedAt: null }]),
}));

describe('sitemap', () => {
  it('lists static routes plus published markets, core services, resources and listings only', async () => {
    const { default: sitemap } = await import('./sitemap');
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toContain('https://simplexd.test/');
    expect(urls).toContain('https://simplexd.test/locations/lagos');
    expect(urls).toContain('https://simplexd.test/locations/ibadan');
    expect(urls).toContain('https://simplexd.test/services/due-diligence');
    expect(urls).toContain('https://simplexd.test/resources/title-checks');
    expect(urls).toContain('https://simplexd.test/properties/plot-12');
    // Planned services, drafts of other kinds and private surfaces never appear.
    expect(urls).not.toContain('https://simplexd.test/services/facility-management');
    expect(urls.some((u) => u.includes('should-not-appear'))).toBe(false);
    for (const surface of ['/portal', '/admin', '/partner', '/tenant', '/preview', '/api', '/setup'])
      expect(urls.some((u) => u.startsWith(`https://simplexd.test${surface}`)), surface).toBe(false);
    expect(new Set(urls).size).toBe(urls.length);
    const lagos = (await sitemap()).find((e) => e.url.endsWith('/locations/lagos'));
    expect(lagos?.lastModified).toBe('2026-09-01T00:00:00.000Z');
  });

  it('keeps the other sources when one fails', async () => {
    const catalog = await import('@/server/services/catalog');
    vi.mocked(catalog.listServiceCatalog).mockRejectedValueOnce(new Error('db down'));
    const { default: sitemap } = await import('./sitemap');
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).not.toContain('https://simplexd.test/services/due-diligence');
    expect(urls).toContain('https://simplexd.test/locations/lagos');
  });
});

describe('robots', () => {
  it('disallows portal, admin, partner, tenant, preview, api and setup and points at the sitemap', async () => {
    const { default: robots } = await import('./robots');
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    const disallow = rules.flatMap((r) =>
      Array.isArray(r.disallow) ? r.disallow : r.disallow ? [r.disallow] : [],
    );
    for (const surface of ['/portal', '/admin', '/partner', '/tenant', '/preview', '/api', '/setup'])
      expect(disallow, surface).toContain(surface);
    expect(rules[0]?.allow).toBe('/');
    expect(result.sitemap).toBe('https://simplexd.test/sitemap.xml');
    expect(result.host).toBe('https://simplexd.test');
  });
});

describe('location page indexability', () => {
  const market = {
    slug: 'ibadan',
    name: 'Ibadan',
    stateName: 'Oyo',
    isFederalCapital: false,
    serviceAvailability: 'pending_operations_confirmation',
    profileMarkdown: null,
    evidence: { localObservations: 0, regionalContextObservations: 0 },
  };
  const siteData = {
    loadMarket: vi.fn(),
    loadLocationIntro: vi.fn(async () => null),
    publicMetadata: (input: { noindex?: boolean; title: string; path: string }) => ({
      title: input.title,
      alternates: { canonical: input.path },
      ...(input.noindex ? { robots: { index: false, follow: false } } : {}),
    }),
    excerpt: () => 'x',
    absoluteUrl: (p: string) => `https://simplexd.test${p}`,
    siteUrl: () => 'https://simplexd.test',
  };
  vi.doMock('@/app/(public)/_lib/site-data', () => siteData);

  it('is noindex without evidence, profile or intro, and indexable once a CMS intro is published', async () => {
    const { generateMetadata } = await import('./(public)/locations/[slug]/page');
    const params = Promise.resolve({ slug: 'ibadan' });
    siteData.loadMarket.mockResolvedValue({ status: 'ok', market });
    const incomplete = await generateMetadata({ params });
    expect(incomplete.robots).toEqual({ index: false, follow: false });

    siteData.loadLocationIntro.mockResolvedValueOnce({
      slug: 'location-intro-ibadan',
      kind: 'location_intro',
      title: 'Ibadan',
      bodyHtml: '<p>Intro</p>',
      bodyMarkdown: 'Intro',
      fields: {},
      seo: null,
      publishedAt: null,
    } as never);
    const withIntro = await generateMetadata({ params });
    expect(withIntro.robots).toBeUndefined();

    siteData.loadMarket.mockResolvedValue({
      status: 'ok',
      market: { ...market, evidence: { localObservations: 2, regionalContextObservations: 0 } },
    });
    const withEvidence = await generateMetadata({ params });
    expect(withEvidence.robots).toBeUndefined();

    siteData.loadMarket.mockResolvedValue({ status: 'missing' });
    expect((await generateMetadata({ params })).robots).toEqual({ index: false, follow: false });
    siteData.loadMarket.mockResolvedValue({ status: 'unavailable' });
    expect((await generateMetadata({ params })).robots).toEqual({ index: false, follow: false });
  });
});
