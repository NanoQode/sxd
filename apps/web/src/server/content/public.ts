import 'server-only';
import { and, asc, eq, isNotNull, lte, or } from 'drizzle-orm';
import type { PublishedContent } from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import { cached } from '@/lib/cache';
import { renderMarkdown } from '@/lib/markdown';

const anonymous = { userId: null, organizationId: null, staff: false } as const;

function toPublished(
  page: typeof schema.contentPages.$inferSelect,
  rev: typeof schema.contentRevisions.$inferSelect,
): PublishedContent {
  return {
    slug: page.slug,
    kind: page.kind,
    title: rev.title,
    bodyHtml: rev.bodyHtmlSanitized ?? renderMarkdown(rev.bodyMarkdown),
    bodyMarkdown: rev.bodyMarkdown,
    fields: (rev.fields as Record<string, unknown> | null) ?? {},
    seo: page.seo ?? null,
    publishedAt: page.publishedAt?.toISOString() ?? null,
  };
}

/** Returns the published revision of a page, or null. Cached briefly; publishing invalidates. */
export async function getPublishedContent(slug: string): Promise<PublishedContent | null> {
  return cached(`content:${slug}`, 60, async () => {
    const rows = await withActor(getDb(), anonymous, (tx) =>
      tx
        .select({ page: schema.contentPages, rev: schema.contentRevisions })
        .from(schema.contentPages)
        .innerJoin(
          schema.contentRevisions,
          and(
            eq(schema.contentRevisions.pageId, schema.contentPages.id),
            eq(schema.contentRevisions.revision, schema.contentPages.publishedRevision),
          ),
        )
        .where(
          and(
            eq(schema.contentPages.slug, slug),
            eq(schema.contentPages.status, 'published'),
            isNotNull(schema.contentPages.publishedRevision),
          ),
        ),
    );
    const row = rows[0];
    return row ? toPublished(row.page, row.rev) : null;
  });
}

/** Lists published pages of a kind (FAQs, resources, policies, goal paths…), ordered. */
export async function listPublishedContent(
  kind: PublishedContent['kind'],
): Promise<PublishedContent[]> {
  return cached(`content-kind:${kind}`, 60, async () => {
    const now = new Date();
    const rows = await withActor(getDb(), anonymous, (tx) =>
      tx
        .select({ page: schema.contentPages, rev: schema.contentRevisions })
        .from(schema.contentPages)
        .innerJoin(
          schema.contentRevisions,
          and(
            eq(schema.contentRevisions.pageId, schema.contentPages.id),
            eq(schema.contentRevisions.revision, schema.contentPages.publishedRevision),
          ),
        )
        .where(
          and(
            eq(schema.contentPages.kind, kind),
            or(
              eq(schema.contentPages.status, 'published'),
              and(
                eq(schema.contentPages.status, 'scheduled'),
                lte(schema.contentPages.publishAt, now),
              ),
            ),
            isNotNull(schema.contentPages.publishedRevision),
          ),
        )
        .orderBy(asc(schema.contentPages.sortOrder), asc(schema.contentPages.title)),
    );
    return rows.map((r) => toPublished(r.page, r.rev));
  });
}
