import type { MetadataRoute } from 'next';
import { anonymousActor } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { listPublishedContent } from '@/server/content/public';
import { listPublishedListings } from '@/server/listings/public';
import { listMarkets } from '@/server/markets/queries';
import { listServiceCatalog } from '@/server/services/catalog';

/**
 * Public sitemap: static routes plus published markets, core services,
 * resources and listings. Private surfaces, previews and the API are never
 * listed. Each dynamic source is loaded independently so one failure does not
 * empty the sitemap.
 */

const STATIC_ROUTES: Array<{ path: string; priority: number; changeFrequency: 'daily' | 'weekly' | 'monthly' }> = [
  { path: '/', priority: 1, changeFrequency: 'weekly' },
  { path: '/explore', priority: 0.9, changeFrequency: 'daily' },
  { path: '/services', priority: 0.9, changeFrequency: 'weekly' },
  { path: '/pricing', priority: 0.8, changeFrequency: 'weekly' },
  { path: '/locations', priority: 0.8, changeFrequency: 'daily' },
  { path: '/properties', priority: 0.7, changeFrequency: 'daily' },
  { path: '/projects', priority: 0.5, changeFrequency: 'monthly' },
  { path: '/how-it-works', priority: 0.7, changeFrequency: 'monthly' },
  { path: '/resources', priority: 0.6, changeFrequency: 'weekly' },
  { path: '/diaspora', priority: 0.6, changeFrequency: 'monthly' },
  { path: '/local-nigeria', priority: 0.6, changeFrequency: 'monthly' },
  { path: '/about', priority: 0.5, changeFrequency: 'monthly' },
  { path: '/contact', priority: 0.5, changeFrequency: 'monthly' },
  { path: '/book', priority: 0.8, changeFrequency: 'monthly' },
];

const anonymousIdentity: RequestIdentity = {
  session: null,
  actor: { ...anonymousActor, flags: {} },
  ctx: { userId: null, organizationId: null, staff: false, anonymousToken: null },
  profile: null,
  featureFlags: {},
};

async function safe<T>(label: string, load: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await load();
  } catch (err) {
    logger().warn({ err: (err as Error).message, label }, 'sitemap source unavailable');
    return fallback;
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = env().APP_URL.replace(/\/$/, '');
  const entries: MetadataRoute.Sitemap = STATIC_ROUTES.map((r) => ({
    url: `${base}${r.path}`,
    priority: r.priority,
    changeFrequency: r.changeFrequency,
  }));

  const [markets, catalog, resources, listings] = await Promise.all([
    safe(
      'markets',
      () => listMarkets({ evidenceStatus: 'any', includeUnpublished: false, limit: 200 }, anonymousIdentity),
      null,
    ),
    safe('services', () => listServiceCatalog(), null),
    safe('resources', () => listPublishedContent('resource'), []),
    safe('listings', () => listPublishedListings(), []),
  ]);

  for (const m of markets?.items ?? []) {
    entries.push({
      url: `${base}/locations/${m.slug}`,
      priority: 0.7,
      changeFrequency: 'weekly',
      ...(m.evidence.lastReviewedAt ? { lastModified: m.evidence.lastReviewedAt } : {}),
    });
  }
  for (const s of catalog?.core ?? []) {
    entries.push({ url: `${base}/services/${s.slug}`, priority: 0.8, changeFrequency: 'weekly' });
  }
  for (const r of resources) {
    entries.push({
      url: `${base}/resources/${r.slug}`,
      priority: 0.5,
      changeFrequency: 'monthly',
      ...(r.publishedAt ? { lastModified: r.publishedAt } : {}),
    });
  }
  for (const l of listings) {
    entries.push({
      url: `${base}/properties/${l.slug}`,
      priority: 0.6,
      changeFrequency: 'weekly',
      ...(l.publishedAt ? { lastModified: l.publishedAt } : {}),
    });
  }
  return entries;
}
