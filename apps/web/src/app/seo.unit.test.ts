import { describe, expect, it, vi } from 'vitest';

/**
 * Crawl controls: the sitemap lists only published public entities, robots
 * disallows every private surface, and location pages without evidence or
 * editorial text are noindex.
 */

vi.mock('@/lib/env', () => ({ env: () => ({ APP_URL: 'https://simplexd.test/' }) }));
vi.mock('@/lib/logger', () => ({
  logger: () => ({ warn: () => undefined, info: () => undefined }),
}));

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
    for (const surface of [
      '/portal',
      '/admin',
      '/partner',
      '/tenant',
      '/preview',
      '/api',
      '/setup',
    ])
      expect(
        urls.some((u) => u.startsWith(`https://simplexd.test${surface}`)),
        surface,
      ).toBe(false);
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
    for (const surface of [
      '/portal',
      '/admin',
      '/partner',
      '/tenant',
      '/preview',
      '/api',
      '/setup',
    ])
      expect(disallow, surface).toContain(surface);
    expect(rules[0]?.allow).toBe('/');
    expect(result.sitemap).toBe('https://simplexd.test/sitemap.xml');
    expect(result.host).toBe('https://simplexd.test');
  });
});

vi.mock('@/app/(public)/_lib/site-data', () => ({
  publicMetadata: (input: {
    noindex?: boolean;
    title: string;
    description: string;
    path: string;
  }) => ({
    title: input.title,
    description: input.description,
    alternates: { canonical: input.path },
    ...(input.noindex ? { robots: { index: false, follow: false } } : {}),
  }),
  excerpt: (page: { bodyMarkdown: string }) => page.bodyMarkdown,
}));

describe('location page indexability', () => {
  const market = {
    slug: 'ibadan',
    name: 'Ibadan',
    stateName: 'Oyo',
    isFederalCapital: false,
    serviceAvailability: 'pending_operations_confirmation',
    profileMarkdown: null,
    evidence: { localObservations: 0, regionalContextObservations: 0 },
  } as never;
  const intro = {
    slug: 'location-intro-ibadan',
    kind: 'location_intro',
    title: 'Ibadan',
    bodyHtml: '<p>Intro</p>',
    bodyMarkdown: 'A growing university city.',
    fields: {},
    seo: { title: 'Ibadan property market' },
    publishedAt: null,
  } as never;

  it('is noindex without evidence, profile or intro, and indexable once a CMS intro is published', async () => {
    const { locationMetadata } = await import('./(public)/locations/[slug]/metadata');
    const incomplete = locationMetadata({
      slug: 'ibadan',
      result: { status: 'ok', market },
      intro: null,
    });
    expect(incomplete.robots).toEqual({ index: false, follow: false });
    expect(incomplete.alternates?.canonical).toBe('/locations/ibadan');

    const withIntro = locationMetadata({ slug: 'ibadan', result: { status: 'ok', market }, intro });
    expect(withIntro.robots).toBeUndefined();
    expect(withIntro.title).toBe('Ibadan property market');
    expect(withIntro.description).toBe('A growing university city.');

    const withEvidence = locationMetadata({
      slug: 'ibadan',
      result: {
        status: 'ok',
        market: {
          ...(market as object),
          evidence: { localObservations: 2, regionalContextObservations: 0 },
        } as never,
      },
      intro: null,
    });
    expect(withEvidence.robots).toBeUndefined();
    expect(withEvidence.title).toBe('Ibadan, Oyo State');

    expect(
      locationMetadata({ slug: 'x', result: { status: 'missing' }, intro: null }).robots,
    ).toEqual({
      index: false,
      follow: false,
    });
    expect(
      locationMetadata({ slug: 'x', result: { status: 'unavailable' }, intro: null }).robots,
    ).toEqual({
      index: false,
      follow: false,
    });
  });
});
