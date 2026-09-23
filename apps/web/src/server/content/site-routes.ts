import 'server-only';
import { and, eq, inArray, isNotNull, lte, or } from 'drizzle-orm';
import { schema, type Transaction } from '@simplexd/db';
import { dynamicRouteOf, isStaticPublicRoute, normalizeSitePath } from '@/lib/site-routes';

/**
 * Decides whether an app path currently resolves to a live public page:
 * a static route, or a dynamic route whose entity is published. Used to
 * refuse redirects that would shadow a page and by the inventory
 * reconciliation to confirm migration targets.
 */

export type LivePageKind = 'static' | 'market' | 'service' | 'resource' | 'policy' | 'listing';

/** Policies that render from built-in templates even without a CMS page. */
const BUILT_IN_POLICIES = new Set(['privacy', 'terms']);

async function publishedContentExists(
  tx: Transaction,
  slug: string,
  kind: 'resource' | 'policy',
): Promise<boolean> {
  const now = new Date();
  const rows = await tx
    .select({ id: schema.contentPages.id })
    .from(schema.contentPages)
    .where(
      and(
        eq(schema.contentPages.slug, slug),
        eq(schema.contentPages.kind, kind),
        isNotNull(schema.contentPages.publishedRevision),
        or(
          eq(schema.contentPages.status, 'published'),
          and(eq(schema.contentPages.status, 'scheduled'), lte(schema.contentPages.publishAt, now)),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function livePageKind(tx: Transaction, path: string): Promise<LivePageKind | null> {
  const p = normalizeSitePath(path);
  if (isStaticPublicRoute(p)) return 'static';
  const dynamic = dynamicRouteOf(p);
  if (!dynamic) return null;
  switch (dynamic.kind) {
    case 'market': {
      const rows = await tx
        .select({ id: schema.markets.id })
        .from(schema.markets)
        .where(
          and(
            eq(schema.markets.slug, dynamic.slug),
            eq(schema.markets.publicationState, 'published'),
          ),
        )
        .limit(1);
      return rows.length > 0 ? 'market' : null;
    }
    case 'service': {
      const rows = await tx
        .select({ id: schema.services.id })
        .from(schema.services)
        .where(
          and(
            eq(schema.services.slug, dynamic.slug),
            eq(schema.services.publicationState, 'published'),
          ),
        )
        .limit(1);
      return rows.length > 0 ? 'service' : null;
    }
    case 'resource':
      return (await publishedContentExists(tx, dynamic.slug, 'resource')) ? 'resource' : null;
    case 'policy':
      if (BUILT_IN_POLICIES.has(dynamic.slug)) return 'policy';
      return (await publishedContentExists(tx, dynamic.slug, 'policy')) ? 'policy' : null;
    case 'listing': {
      const rows = await tx
        .select({ id: schema.listings.id })
        .from(schema.listings)
        .where(
          and(
            eq(schema.listings.slug, dynamic.slug),
            inArray(schema.listings.status, ['published']),
          ),
        )
        .limit(1);
      return rows.length > 0 ? 'listing' : null;
    }
  }
}
