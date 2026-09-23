import { describe, expect, it } from 'vitest';
import type { PublishedContent } from '@simplexd/contracts';
import { GOAL_PATHS } from './defaults';
import { FOOTER_EXPLORE_LINKS, PRIMARY_LINKS, SECONDARY_LINKS } from './nav-data';
import {
  activeBanners,
  goalPathsFromContent,
  locationIntroFrom,
  locationIsIncomplete,
  navigationFromContent,
} from './site-content';

function page(patch: Partial<PublishedContent> & { slug: string; kind: PublishedContent['kind'] }) {
  return {
    title: patch.slug,
    bodyHtml: '',
    bodyMarkdown: '',
    fields: {},
    seo: null,
    publishedAt: '2026-09-01T00:00:00.000Z',
    ...patch,
  } satisfies PublishedContent;
}

describe('banners', () => {
  const now = new Date('2026-09-23T12:00:00Z');

  it('shows published banners inside their window and keys dismissal by publication', () => {
    const banners = activeBanners(
      [
        page({
          slug: 'launch',
          kind: 'banner',
          fields: { message: 'Bookings open', href: '/book', tone: 'success' },
        }),
        page({
          slug: 'future',
          kind: 'banner',
          fields: { message: 'Later', startsAt: '2026-10-01T00:00:00Z' },
        }),
        page({
          slug: 'expired',
          kind: 'banner',
          fields: { message: 'Gone', endsAt: '2026-09-01T00:00:00Z' },
        }),
        page({ slug: 'not-a-banner', kind: 'page', fields: { message: 'x' } }),
        page({ slug: 'empty', kind: 'banner', fields: {} }),
      ],
      now,
    );
    expect(banners.map((b) => b.slug)).toEqual(['launch']);
    expect(banners[0]).toMatchObject({
      id: 'launch:2026-09-01T00:00:00.000Z',
      message: 'Bookings open',
      href: '/book',
      linkLabel: 'Read more',
      tone: 'success',
      dismissible: true,
      bodyHtml: null,
    });
  });

  it('falls back to the sanitised body, ignores invalid fields and never accepts script links', () => {
    const [rich] = activeBanners(
      [
        page({
          slug: 'rich',
          kind: 'banner',
          bodyHtml: '<p>Read the <a href="https://x.test">notice</a></p>',
          fields: { tone: 'shout', href: 'javascript:alert(1)', dismissible: false },
        }),
      ],
      now,
    );
    // Invalid fields as a whole fall back to defaults: info tone, dismissible, no link.
    expect(rich).toMatchObject({ tone: 'info', href: null, dismissible: true });
    expect(rich!.bodyHtml).toContain('<a href="https://x.test">');
  });
});

describe('navigation', () => {
  it('keeps every default slot when nothing is published', () => {
    const nav = navigationFromContent([]);
    expect(nav.primary).toBe(PRIMARY_LINKS);
    expect(nav.secondary).toBe(SECONDARY_LINKS);
    expect(nav.footerExplore).toBe(FOOTER_EXPLORE_LINKS);
    expect(nav.fromCms).toEqual([]);
  });

  it('fills a slot from fields.slot or the slug and ignores invalid or duplicate pages', () => {
    const nav = navigationFromContent([
      page({
        slug: 'main-menu',
        kind: 'navigation',
        fields: {
          slot: 'header',
          items: [
            { label: 'Explore', href: '/explore' },
            { label: 'Guides', href: 'https://guides.example.test' },
          ],
        },
      }),
      page({
        slug: 'navigation-footer-explore',
        kind: 'navigation',
        fields: { items: [{ label: 'Map', href: '/explore' }] },
      }),
      page({
        slug: 'header',
        kind: 'navigation',
        fields: { items: [{ label: 'Duplicate', href: '/x' }] },
      }),
      page({
        slug: 'footer-company',
        kind: 'navigation',
        fields: { items: [{ label: 'Bad', href: 'javascript:alert(1)' }] },
      }),
      page({ slug: 'no-slot', kind: 'navigation', fields: { items: [{ label: 'A', href: '/a' }] } }),
    ]);
    expect(nav.primary).toEqual([
      { label: 'Explore', href: '/explore' },
      { label: 'Guides', href: 'https://guides.example.test' },
    ]);
    expect(nav.footerExplore).toEqual([{ label: 'Map', href: '/explore' }]);
    expect(nav.footerCompany).toEqual(navigationFromContent([]).footerCompany);
    expect(nav.fromCms).toEqual(['header', 'footer-explore']);
  });
});

describe('goal paths', () => {
  it('returns the defaults when no goal_path page is published', () => {
    expect(goalPathsFromContent([])).toBe(GOAL_PATHS);
  });

  it('overrides matching keys only, keeps default order for partial coverage, and ignores unknown keys', () => {
    const goals = goalPathsFromContent([
      page({
        slug: 'goal-manage-property',
        kind: 'goal_path',
        title: 'Manage from abroad',
        fields: {
          key: 'manage_property',
          description: 'Reconciled statements.',
          href: '/services/property-management',
          serviceSlugs: ['property-management'],
        },
      }),
      page({ slug: 'goal-unknown', kind: 'goal_path', fields: { key: 'flip_houses' } }),
    ]);
    expect(goals.map((g) => g.key)).toEqual(GOAL_PATHS.map((g) => g.key));
    const managed = goals.find((g) => g.key === 'manage_property')!;
    expect(managed).toMatchObject({
      title: 'Manage from abroad',
      description: 'Reconciled statements.',
      href: '/services/property-management',
      serviceSlugs: ['property-management'],
      exploreHref: GOAL_PATHS.find((g) => g.key === 'manage_property')!.exploreHref,
    });
    expect(goals.find((g) => g.key === 'buy_safely')).toBe(
      GOAL_PATHS.find((g) => g.key === 'buy_safely'),
    );
  });

  it('honours the editors’ order once every card is CMS-managed', () => {
    const order = ['invest_and_compare', 'manage_property', 'build_with_oversight', 'buy_safely'];
    const goals = goalPathsFromContent(
      order.map((key) => page({ slug: `goal-${key}`, kind: 'goal_path', fields: { key } })),
    );
    expect(goals.map((g) => g.key)).toEqual(order);
  });
});

describe('location intros', () => {
  const pages = [
    page({ slug: 'location-intro-ibadan', kind: 'location_intro' }),
    page({ slug: 'lekki-story', kind: 'location_intro', fields: { marketSlug: 'lekki' } }),
    page({ slug: 'location-intro-abuja', kind: 'page' }),
  ];

  it('matches by fields.marketSlug first, then by slug convention, never other kinds', () => {
    expect(locationIntroFrom(pages, 'lekki')?.slug).toBe('lekki-story');
    expect(locationIntroFrom(pages, 'ibadan')?.slug).toBe('location-intro-ibadan');
    expect(locationIntroFrom(pages, 'abuja')).toBeNull();
  });

  it('marks a location complete when it has evidence, a profile or a published intro', () => {
    const bare = { localObservations: 0, regionalContextObservations: 0, profileMarkdown: null };
    expect(locationIsIncomplete({ ...bare, hasIntro: false })).toBe(true);
    expect(locationIsIncomplete({ ...bare, hasIntro: true })).toBe(false);
    expect(locationIsIncomplete({ ...bare, localObservations: 1, hasIntro: false })).toBe(false);
    expect(locationIsIncomplete({ ...bare, profileMarkdown: 'x', hasIntro: false })).toBe(false);
  });
});
