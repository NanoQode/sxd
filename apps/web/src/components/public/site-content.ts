import {
  bannerFieldsSchema,
  goalPathFieldsSchema,
  NAVIGATION_SLOTS,
  navigationFieldsSchema,
  type BannerTone,
  type NavigationSlot,
  type PublishedContent,
} from '@simplexd/contracts';
import { GOAL_PATHS, type GoalPath } from './defaults';
import {
  FOOTER_COMPANY_LINKS,
  FOOTER_EXPLORE_LINKS,
  PRIMARY_LINKS,
  SECONDARY_LINKS,
  type NavLink,
} from './nav-data';

/**
 * Pure mappers from published CMS pages to what the public shell renders.
 * Every mapper validates the structured `fields` with the shared zod schema
 * and falls back to the built-in defaults when a page is missing or invalid,
 * so a malformed edit can never blank the navigation or the homepage.
 */

/* ------------------------------------------------------------------ */
/* Banners                                                              */
/* ------------------------------------------------------------------ */

export interface SiteBanner {
  /** Stable per publication: dismissals are stored against it, so a republish shows the banner again. */
  id: string;
  slug: string;
  message: string;
  /** Sanitised HTML used when the banner has no plain-text message. */
  bodyHtml: string | null;
  href: string | null;
  linkLabel: string | null;
  tone: BannerTone;
  dismissible: boolean;
}

function withinWindow(
  startsAt: string | null | undefined,
  endsAt: string | null | undefined,
  now: Date,
) {
  const t = now.getTime();
  if (startsAt && new Date(startsAt).getTime() > t) return false;
  if (endsAt && new Date(endsAt).getTime() <= t) return false;
  return true;
}

/** Published banners whose optional display window contains `now`, in sort order. */
export function activeBanners(pages: PublishedContent[], now: Date = new Date()): SiteBanner[] {
  const out: SiteBanner[] = [];
  for (const page of pages) {
    if (page.kind !== 'banner') continue;
    const parsed = bannerFieldsSchema.safeParse(page.fields);
    const fields = parsed.success ? parsed.data : bannerFieldsSchema.parse({});
    if (!withinWindow(fields.startsAt, fields.endsAt, now)) continue;
    const message = (fields.message ?? '').trim();
    const bodyHtml = page.bodyHtml.trim();
    if (!message && !bodyHtml) continue;
    out.push({
      id: `${page.slug}:${page.publishedAt ?? 'unpublished'}`,
      slug: page.slug,
      message: message || page.title,
      bodyHtml: message ? null : bodyHtml || null,
      href: fields.href ?? null,
      linkLabel: fields.href ? fields.linkLabel?.trim() || 'Read more' : null,
      tone: fields.tone,
      dismissible: fields.dismissible,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Navigation                                                           */
/* ------------------------------------------------------------------ */

export interface SiteNavigation {
  primary: NavLink[];
  secondary: NavLink[];
  footerExplore: NavLink[];
  footerCompany: NavLink[];
  /** Slots that came from a published page (the rest are defaults). */
  fromCms: NavigationSlot[];
}

export const DEFAULT_NAVIGATION: SiteNavigation = {
  primary: PRIMARY_LINKS,
  secondary: SECONDARY_LINKS,
  footerExplore: FOOTER_EXPLORE_LINKS,
  footerCompany: FOOTER_COMPANY_LINKS,
  fromCms: [],
};

function slotOf(
  page: PublishedContent,
  explicit: NavigationSlot | undefined,
): NavigationSlot | null {
  if (explicit) return explicit;
  for (const slot of NAVIGATION_SLOTS) {
    if (page.slug === slot || page.slug === `navigation-${slot}`) return slot;
  }
  return null;
}

/**
 * Header and footer links from published `navigation` pages. The services
 * mega-menu is not editable here: it always lists the catalogue.
 */
export function navigationFromContent(pages: PublishedContent[]): SiteNavigation {
  const nav: SiteNavigation = { ...DEFAULT_NAVIGATION, fromCms: [] };
  for (const page of pages) {
    if (page.kind !== 'navigation') continue;
    const parsed = navigationFieldsSchema.safeParse(page.fields);
    if (!parsed.success) continue;
    const slot = slotOf(page, parsed.data.slot);
    if (!slot || nav.fromCms.includes(slot)) continue;
    const items: NavLink[] = parsed.data.items.map((i) => ({ href: i.href, label: i.label }));
    switch (slot) {
      case 'header':
        nav.primary = items;
        break;
      case 'header-secondary':
        nav.secondary = items;
        break;
      case 'footer-explore':
        nav.footerExplore = items;
        break;
      case 'footer-company':
        nav.footerCompany = items;
        break;
    }
    nav.fromCms.push(slot);
  }
  return nav;
}

/* ------------------------------------------------------------------ */
/* Goal paths                                                           */
/* ------------------------------------------------------------------ */

/**
 * Homepage goal cards. A published `goal_path` page overrides the default
 * card with the same `fields.key` (title from the page title, description
 * from `fields.description` or the summary field, links and service slugs
 * when set). Cards keep the default order unless the CMS pages carry a
 * different sort order, in which case published order wins.
 */
export function goalPathsFromContent(pages: PublishedContent[]): GoalPath[] {
  const overrides = new Map<string, { goal: GoalPath; index: number }>();
  let index = 0;
  for (const page of pages) {
    if (page.kind !== 'goal_path') continue;
    const parsed = goalPathFieldsSchema.safeParse(page.fields);
    if (!parsed.success || overrides.has(parsed.data.key)) continue;
    const base = GOAL_PATHS.find((g) => g.key === parsed.data.key);
    if (!base) continue;
    const summary = typeof page.fields.summary === 'string' ? page.fields.summary.trim() : '';
    const description = parsed.data.description?.trim() || summary || base.description;
    const href = parsed.data.href ?? base.href;
    overrides.set(parsed.data.key, {
      goal: {
        key: base.key,
        title: page.title.trim() || base.title,
        description,
        href,
        exploreHref: parsed.data.exploreHref ?? base.exploreHref,
        serviceSlugs:
          parsed.data.serviceSlugs && parsed.data.serviceSlugs.length > 0
            ? parsed.data.serviceSlugs
            : base.serviceSlugs,
      },
      index: index++,
    });
  }
  if (overrides.size === 0) return GOAL_PATHS;
  const merged = GOAL_PATHS.map((g) => overrides.get(g.key)?.goal ?? g);
  if (overrides.size < GOAL_PATHS.length) return merged;
  // Every card is CMS-managed: honour the editors' ordering.
  return [...merged].sort(
    (a, b) => (overrides.get(a.key)?.index ?? 0) - (overrides.get(b.key)?.index ?? 0),
  );
}

/* ------------------------------------------------------------------ */
/* Location intros                                                      */
/* ------------------------------------------------------------------ */

/** Picks the published intro for a market from `location_intro` pages (fallback to slug convention). */
export function locationIntroFrom(
  pages: PublishedContent[],
  marketSlug: string,
): PublishedContent | null {
  return (
    pages.find((p) => p.kind === 'location_intro' && p.fields.marketSlug === marketSlug) ??
    pages.find(
      (p) =>
        p.kind === 'location_intro' &&
        (p.slug === `location-intro-${marketSlug}` || p.slug === marketSlug),
    ) ??
    null
  );
}

/**
 * A location page is "incomplete" (noindex) when it has neither evidence
 * nor editorial text. A published CMS intro counts as editorial text.
 */
export function locationIsIncomplete(input: {
  localObservations: number;
  regionalContextObservations: number;
  profileMarkdown: string | null;
  hasIntro: boolean;
}): boolean {
  return (
    input.localObservations + input.regionalContextObservations === 0 &&
    !input.profileMarkdown &&
    !input.hasIntro
  );
}
