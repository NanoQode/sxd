import 'server-only';
import { cache } from 'react';
import type { Metadata } from 'next';
import { unstable_rethrow } from 'next/navigation';
import type { MarketDetailDto, MarketListResponse, PublishedContent } from '@simplexd/contracts';
import type { EvidenceBadgeKind } from '@simplexd/ui';
import { getIdentity } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { plainTextExcerpt } from '@/lib/markdown';
import { getPublishedContent, listPublishedContent } from '@/server/content/public';
import { getMarketBySlug, listMarkets } from '@/server/markets/queries';
import { listServiceCatalog, type ServiceCatalog } from '@/server/services/catalog';
import { SITE, type FaqItem } from '@/components/public/defaults';
import {
  defaultEvidenceStandards,
  type EvidenceStandardItem,
} from '@/components/public/evidence-standards';
import { CORE_SERVICE_NAV, type NavServiceItem } from '@/components/public/nav-data';

/**
 * Shared loaders for the public site. Every loader degrades honestly: a
 * database or upstream failure yields null/empty data plus a logged warning,
 * so pages render their "not available yet" states instead of crashing.
 */

export function siteUrl(): string {
  return env().APP_URL.replace(/\/$/, '');
}

export function absoluteUrl(path: string): string {
  return `${siteUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

export function publicMetadata(input: {
  title: string;
  description: string;
  path: string;
  noindex?: boolean;
  type?: 'website' | 'article';
  absoluteTitle?: boolean;
}): Metadata {
  const description =
    input.description.length > 300 ? `${input.description.slice(0, 297)}…` : input.description;
  return {
    title: input.absoluteTitle ? { absolute: input.title } : input.title,
    description,
    alternates: { canonical: input.path },
    openGraph: {
      title: input.title,
      description,
      url: input.path,
      siteName: SITE.name,
      locale: 'en_NG',
      type: input.type ?? 'website',
    },
    twitter: { card: 'summary', title: input.title, description },
    ...(input.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

export const loadCatalog = cache(async (): Promise<ServiceCatalog | null> => {
  try {
    return await listServiceCatalog();
  } catch (err) {
    // Rendering signals (dynamic usage, notFound, redirect) belong to Next.
    unstable_rethrow(err);
    logger().warn({ err: (err as Error).message }, 'service catalogue unavailable');
    return null;
  }
});

export const navServices = cache(async (): Promise<NavServiceItem[]> => {
  const catalog = await loadCatalog();
  if (!catalog || catalog.core.length === 0) return CORE_SERVICE_NAV;
  return catalog.core.map((s) => ({
    slug: s.slug,
    name: s.name,
    hint:
      CORE_SERVICE_NAV.find((n) => n.slug === s.slug)?.hint ??
      s.deliverables[0] ??
      s.shortDescription,
  }));
});

export const contentBySlug = cache(
  async (slug: string, kind: PublishedContent['kind']): Promise<PublishedContent | null> => {
    try {
      const page = await getPublishedContent(slug);
      return page && page.kind === kind ? page : null;
    } catch (err) {
      // Rendering signals (dynamic usage, notFound, redirect) belong to Next.
      unstable_rethrow(err);
      logger().warn({ err: (err as Error).message, slug }, 'content unavailable');
      return null;
    }
  },
);

export const contentByKind = cache(
  async (kind: PublishedContent['kind']): Promise<PublishedContent[]> => {
    try {
      return await listPublishedContent(kind);
    } catch (err) {
      // Rendering signals (dynamic usage, notFound, redirect) belong to Next.
      unstable_rethrow(err);
      logger().warn({ err: (err as Error).message, kind }, 'content list unavailable');
      return [];
    }
  },
);

export type MarketsResult = { status: 'ok'; data: MarketListResponse } | { status: 'unavailable' };

export const loadMarkets = cache(async (): Promise<MarketsResult> => {
  try {
    const identity = await getIdentity();
    const data = await listMarkets(
      { evidenceStatus: 'any', includeUnpublished: false, limit: 200 },
      identity,
    );
    return { status: 'ok', data };
  } catch (err) {
    // Rendering signals (dynamic usage, notFound, redirect) belong to Next.
    unstable_rethrow(err);
    logger().warn({ err: (err as Error).message }, 'market list unavailable');
    return { status: 'unavailable' };
  }
});

export type MarketResult =
  { status: 'ok'; market: MarketDetailDto } | { status: 'missing' } | { status: 'unavailable' };

export const loadMarket = cache(async (slug: string): Promise<MarketResult> => {
  try {
    const identity = await getIdentity();
    const market = await getMarketBySlug(slug, identity);
    return market ? { status: 'ok', market } : { status: 'missing' };
  } catch (err) {
    // Rendering signals (dynamic usage, notFound, redirect) belong to Next.
    unstable_rethrow(err);
    logger().warn({ err: (err as Error).message, slug }, 'market detail unavailable');
    return { status: 'unavailable' };
  }
});

export function excerpt(page: PublishedContent, max = 160): string {
  const summary = page.fields.summary;
  if (typeof summary === 'string' && summary.trim()) return summary.trim().slice(0, max);
  if (page.seo?.description) return page.seo.description;
  return plainTextExcerpt(page.bodyMarkdown, max);
}

export function faqsFromContent(pages: PublishedContent[]): FaqItem[] {
  return pages.map((p) => ({
    question: p.title,
    answerHtml: p.bodyHtml,
    answerText: plainTextExcerpt(p.bodyMarkdown, 600),
  }));
}

const BADGES: EvidenceBadgeKind[] = [
  'sourced_observation',
  'verified_operational_record',
  'regional_context',
  'model_estimate',
  'user_assumption',
  'unknown',
  'stale',
  'disputed',
];

export function evidenceStandardsFromContent(pages: PublishedContent[]): EvidenceStandardItem[] {
  const items = pages.flatMap((p) => {
    const badge = p.fields.badge;
    if (typeof badge !== 'string' || !(BADGES as string[]).includes(badge)) return [];
    return [{ badge: badge as EvidenceBadgeKind, title: p.title, descriptionHtml: p.bodyHtml }];
  });
  return items.length > 0 ? items : defaultEvidenceStandards();
}

export function fieldString(page: PublishedContent | null, key: string): string | null {
  const v = page?.fields[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
