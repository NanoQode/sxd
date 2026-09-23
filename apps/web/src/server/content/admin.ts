import 'server-only';
import { and, asc, desc, eq, ilike, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiError,
  type ContentListQuery,
  type ContentPageDetail,
  type ContentPageDto,
  type ContentRevisionCreate,
  type ContentRevisionDto,
  type MediaAssetDto,
  type Page,
  type PublishedContent,
  contentPageCreateSchema,
  contentPagePatchSchema,
  contentPublishActionSchema,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { assertAllowed, authorizeStaff } from '@simplexd/domain/authz';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { cacheDelete } from '@/lib/cache';
import { renderMarkdown } from '@/lib/markdown';
import { decodeCursor, encodeCursor } from '@/server/portal/pagination';

/**
 * CMS administration: draft → review → publish with scheduled publication,
 * revisions, rollback and separation of duties (the person publishing a
 * revision must differ from its author). Publishing invalidates the public
 * content cache and records an audit entry with before/after state.
 */

type PageRow = typeof schema.contentPages.$inferSelect;
type RevisionRow = typeof schema.contentRevisions.$inferSelect;

export function toPageDto(p: PageRow): ContentPageDto {
  return {
    id: p.id,
    slug: p.slug,
    kind: p.kind,
    title: p.title,
    status: p.status,
    locale: p.locale,
    currentRevision: p.currentRevision,
    publishedRevision: p.publishedRevision,
    publishAt: p.publishAt?.toISOString() ?? null,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    seo: p.seo ?? null,
    sortOrder: p.sortOrder,
    version: p.version,
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toRevisionDto(r: RevisionRow): ContentRevisionDto {
  return {
    id: r.id,
    pageId: r.pageId,
    revision: r.revision,
    title: r.title,
    bodyMarkdown: r.bodyMarkdown,
    bodyHtmlSanitized: r.bodyHtmlSanitized,
    fields: (r.fields as Record<string, unknown> | null) ?? null,
    summary: r.summary,
    reviewStatus: r.reviewStatus,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

async function loadPage(tx: Transaction, id: string): Promise<PageRow> {
  const [page] = await tx.select().from(schema.contentPages).where(eq(schema.contentPages.id, id));
  if (!page) throw new ApiError('not_found', 'content page not found');
  return page;
}

async function loadRevision(tx: Transaction, pageId: string, revision: number): Promise<RevisionRow> {
  const [row] = await tx
    .select()
    .from(schema.contentRevisions)
    .where(and(eq(schema.contentRevisions.pageId, pageId), eq(schema.contentRevisions.revision, revision)));
  if (!row) throw new ApiError('not_found', `revision ${revision} not found`);
  return row;
}

export async function listContentPages(
  identity: RequestIdentity,
  query: ContentListQuery,
): Promise<Page<ContentPageDto>> {
  const cursor = decodeCursor(query.cursor);
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select()
      .from(schema.contentPages)
      .where(
        and(
          query.kind ? eq(schema.contentPages.kind, query.kind) : undefined,
          query.status ? eq(schema.contentPages.status, query.status) : undefined,
          query.q
            ? or(ilike(schema.contentPages.title, `%${query.q}%`), ilike(schema.contentPages.slug, `%${query.q}%`))
            : undefined,
          cursor
            ? or(
                lt(schema.contentPages.updatedAt, cursor.createdAt),
                and(eq(schema.contentPages.updatedAt, cursor.createdAt), lt(schema.contentPages.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.contentPages.updatedAt), desc(schema.contentPages.id))
      .limit(query.limit + 1),
  );
  const items = rows.slice(0, query.limit).map(toPageDto);
  const last = rows.length > query.limit ? rows[query.limit - 1] : null;
  return { items, nextCursor: last ? encodeCursor(last.updatedAt, last.id) : null };
}

export async function getContentPageDetail(identity: RequestIdentity, id: string): Promise<ContentPageDetail> {
  return withActor(getDb(), identity.ctx, async (tx) => {
    const page = await loadPage(tx, id);
    const revisions = await tx
      .select({ r: schema.contentRevisions, createdByName: schema.user.name })
      .from(schema.contentRevisions)
      .leftJoin(schema.user, eq(schema.user.id, schema.contentRevisions.createdBy))
      .where(eq(schema.contentRevisions.pageId, id))
      .orderBy(desc(schema.contentRevisions.revision));
    return {
      ...toPageDto(page),
      createdBy: page.createdBy,
      updatedBy: page.updatedBy,
      unpublishedAt: page.unpublishedAt?.toISOString() ?? null,
      relatedEntityType: page.relatedEntityType,
      relatedEntityId: page.relatedEntityId,
      revisions: revisions.map((row) => ({ ...toRevisionDto(row.r), createdByName: row.createdByName })),
    };
  });
}

export async function createContentPage(
  identity: RequestIdentity,
  input: z.infer<typeof contentPageCreateSchema>,
  options: { correlationId: string },
): Promise<ContentPageDto> {
  const parsed = contentPageCreateSchema.parse(input);
  const userId = identity.session!.user.id;
  try {
    return await withActor(getDb(), identity.ctx, async (tx) => {
      const [page] = await tx
        .insert(schema.contentPages)
        .values({
          slug: parsed.slug,
          kind: parsed.kind,
          title: parsed.title,
          status: 'draft',
          locale: parsed.locale,
          currentRevision: 1,
          seo: parsed.seo ?? null,
          sortOrder: parsed.sortOrder,
          relatedEntityType: parsed.relatedEntityType ?? null,
          relatedEntityId: parsed.relatedEntityId ?? null,
          createdBy: userId,
          updatedBy: userId,
        })
        .returning();
      await tx.insert(schema.contentRevisions).values({
        pageId: page!.id,
        revision: 1,
        title: parsed.title,
        bodyMarkdown: parsed.bodyMarkdown,
        bodyHtmlSanitized: renderMarkdown(parsed.bodyMarkdown),
        fields: parsed.fields ?? null,
        summary: parsed.summary ?? null,
        reviewStatus: 'draft',
        createdBy: userId,
      });
      await recordAudit(tx, identity, {
        action: 'content.created',
        entityType: 'content_page',
        entityId: page!.id,
        after: { slug: parsed.slug, kind: parsed.kind, title: parsed.title, revision: 1 },
        correlationId: options.correlationId,
      });
      return toPageDto(page!);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError('conflict', `a page with slug "${parsed.slug}" already exists`);
    throw err;
  }
}

export async function updateContentPageMeta(
  identity: RequestIdentity,
  id: string,
  input: z.infer<typeof contentPagePatchSchema>,
  options: { correlationId: string },
): Promise<ContentPageDto> {
  const parsed = contentPagePatchSchema.parse(input);
  const userId = identity.session!.user.id;
  return withActor(getDb(), identity.ctx, async (tx) => {
    const page = await loadPage(tx, id);
    if (page.version !== parsed.expectedVersion) {
      throw new ApiError('version_conflict', 'this page changed since you loaded it', {
        details: { currentVersion: page.version },
      });
    }
    const [updated] = await tx
      .update(schema.contentPages)
      .set({
        ...(parsed.seo !== undefined ? { seo: parsed.seo } : {}),
        ...(parsed.sortOrder !== undefined ? { sortOrder: parsed.sortOrder } : {}),
        version: page.version + 1,
        updatedBy: userId,
      })
      .where(and(eq(schema.contentPages.id, id), eq(schema.contentPages.version, page.version)))
      .returning();
    if (!updated) throw new ApiError('version_conflict', 'this page changed since you loaded it');
    await recordAudit(tx, identity, {
      action: 'content.meta_updated',
      entityType: 'content_page',
      entityId: id,
      before: { seo: page.seo, sortOrder: page.sortOrder },
      after: { seo: updated.seo, sortOrder: updated.sortOrder },
      correlationId: options.correlationId,
    });
    if (page.status === 'published' || page.status === 'scheduled') await cacheDelete('content');
    return toPageDto(updated);
  });
}

/** Saves a new revision; the public site keeps serving the published revision until publication. */
export async function createContentRevision(
  identity: RequestIdentity,
  id: string,
  input: ContentRevisionCreate,
  options: { correlationId: string },
): Promise<{ page: ContentPageDto; revision: ContentRevisionDto }> {
  const userId = identity.session!.user.id;
  return withActor(getDb(), identity.ctx, async (tx) => {
    const page = await loadPage(tx, id);
    if (page.status === 'archived') throw new ApiError('invalid_transition', 'archived pages cannot be edited');
    if (page.version !== input.expectedVersion) {
      throw new ApiError('version_conflict', 'this page changed since you loaded it', {
        details: { currentVersion: page.version },
      });
    }
    const next = page.currentRevision + 1;
    const [revision] = await tx
      .insert(schema.contentRevisions)
      .values({
        pageId: id,
        revision: next,
        title: input.title,
        bodyMarkdown: input.bodyMarkdown,
        bodyHtmlSanitized: renderMarkdown(input.bodyMarkdown),
        fields: input.fields ?? null,
        summary: input.summary ?? null,
        reviewStatus: 'draft',
        createdBy: userId,
      })
      .returning();
    const [updated] = await tx
      .update(schema.contentPages)
      .set({
        currentRevision: next,
        title: input.title,
        version: page.version + 1,
        updatedBy: userId,
        ...(page.status === 'in_review' ? { status: 'draft' as const } : {}),
      })
      .where(and(eq(schema.contentPages.id, id), eq(schema.contentPages.version, page.version)))
      .returning();
    if (!updated) throw new ApiError('version_conflict', 'this page changed since you loaded it');
    await recordAudit(tx, identity, {
      action: 'content.revision_created',
      entityType: 'content_page',
      entityId: id,
      before: { currentRevision: page.currentRevision },
      after: { currentRevision: next, title: input.title },
      correlationId: options.correlationId,
    });
    return { page: toPageDto(updated), revision: toRevisionDto(revision!) };
  });
}

const PUBLISH_ACTIONS = new Set(['approve', 'publish', 'schedule', 'unpublish', 'archive', 'rollback']);

/**
 * Workflow actions. `submit_for_review` needs content.edit; the rest need
 * content.publish. Publishing, scheduling or rolling back a revision authored
 * by the actor is refused (separation of duties).
 */
export async function applyContentAction(
  identity: RequestIdentity,
  id: string,
  input: z.infer<typeof contentPublishActionSchema>,
  options: { correlationId: string },
): Promise<ContentPageDto> {
  const parsed = contentPublishActionSchema.parse(input);
  const userId = identity.session!.user.id;
  const now = new Date();
  const result = await withActor(getDb(), identity.ctx, async (tx) => {
    const page = await loadPage(tx, id);
    if (page.version !== parsed.expectedVersion) {
      throw new ApiError('version_conflict', 'this page changed since you loaded it', {
        details: { currentVersion: page.version },
      });
    }
    const targetRevision = parsed.revision ?? page.currentRevision;
    const revision = await loadRevision(tx, id, targetRevision);
    if (PUBLISH_ACTIONS.has(parsed.action)) {
      assertAllowed(
        authorizeStaff(identity.actor, 'content.publish', {
          type: 'content_page',
          id,
          createdBy: revision.createdBy,
        }),
      );
    } else {
      assertAllowed(authorizeStaff(identity.actor, 'content.edit', { type: 'content_page', id }));
    }
    const requiresSeparateApprover = ['approve', 'publish', 'schedule', 'rollback'].includes(parsed.action);
    if (requiresSeparateApprover && revision.createdBy && revision.createdBy === userId) {
      throw new ApiError('forbidden', 'the approver must differ from the revision author', {
        details: { code: 'separation_of_duties', revision: targetRevision },
      });
    }

    const before = { status: page.status, publishedRevision: page.publishedRevision, publishAt: page.publishAt };
    const patch: Partial<typeof schema.contentPages.$inferInsert> = { version: page.version + 1, updatedBy: userId };
    let revisionStatus: string | null = null;
    let cacheAffected = false;
    let auditAction = `content.${parsed.action}`;

    switch (parsed.action) {
      case 'submit_for_review': {
        if (page.status === 'archived') throw new ApiError('invalid_transition', 'archived pages cannot be reviewed');
        revisionStatus = 'in_review';
        if (page.publishedRevision === null) patch.status = 'in_review';
        break;
      }
      case 'approve': {
        revisionStatus = 'approved';
        break;
      }
      case 'publish': {
        if (page.status === 'archived') throw new ApiError('invalid_transition', 'restore the page before publishing');
        patch.status = 'published';
        patch.publishedRevision = targetRevision;
        patch.publishedAt = now;
        patch.publishAt = null;
        patch.unpublishedAt = null;
        revisionStatus = 'published';
        cacheAffected = true;
        break;
      }
      case 'schedule': {
        if (!parsed.publishAt) throw new ApiError('validation_failed', 'publishAt is required to schedule');
        const at = new Date(parsed.publishAt);
        if (at.getTime() <= now.getTime()) {
          throw new ApiError('validation_failed', 'publishAt must be in the future; use publish for immediate publication');
        }
        if (page.status === 'archived') throw new ApiError('invalid_transition', 'restore the page before scheduling');
        patch.status = 'scheduled';
        patch.publishedRevision = targetRevision;
        patch.publishAt = at;
        patch.unpublishedAt = null;
        revisionStatus = 'approved';
        cacheAffected = true;
        break;
      }
      case 'unpublish': {
        if (page.status !== 'published' && page.status !== 'scheduled') {
          throw new ApiError('invalid_transition', 'only published or scheduled pages can be unpublished');
        }
        patch.status = 'unpublished';
        patch.unpublishedAt = now;
        patch.publishAt = null;
        cacheAffected = true;
        break;
      }
      case 'archive': {
        patch.status = 'archived';
        patch.unpublishedAt = page.status === 'published' ? now : page.unpublishedAt;
        patch.publishAt = null;
        cacheAffected = page.status === 'published' || page.status === 'scheduled';
        break;
      }
      case 'rollback': {
        if (parsed.revision === undefined) throw new ApiError('validation_failed', 'revision is required to roll back');
        if (parsed.revision >= page.currentRevision && page.publishedRevision === parsed.revision) {
          throw new ApiError('invalid_transition', 'that revision is already live');
        }
        if (revision.reviewStatus !== 'published' && revision.reviewStatus !== 'approved') {
          throw new ApiError('invalid_transition', 'only previously approved or published revisions can be rolled back to');
        }
        patch.status = 'published';
        patch.publishedRevision = parsed.revision;
        patch.publishedAt = now;
        patch.publishAt = null;
        patch.unpublishedAt = null;
        revisionStatus = 'published';
        cacheAffected = true;
        auditAction = 'content.rolled_back';
        break;
      }
    }

    const [updated] = await tx
      .update(schema.contentPages)
      .set(patch)
      .where(and(eq(schema.contentPages.id, id), eq(schema.contentPages.version, page.version)))
      .returning();
    if (!updated) throw new ApiError('version_conflict', 'this page changed since you loaded it');
    if (revisionStatus) {
      await tx
        .update(schema.contentRevisions)
        .set({
          reviewStatus: revisionStatus,
          ...(parsed.action !== 'submit_for_review' ? { reviewedBy: userId, reviewedAt: now } : {}),
        })
        .where(eq(schema.contentRevisions.id, revision.id));
    }
    await recordAudit(tx, identity, {
      action: auditAction,
      entityType: 'content_page',
      entityId: id,
      before,
      after: {
        status: updated.status,
        publishedRevision: updated.publishedRevision,
        publishAt: updated.publishAt,
        revision: targetRevision,
        revisionAuthor: revision.createdBy,
      },
      reason: parsed.note ?? null,
      correlationId: options.correlationId,
    });
    return { dto: toPageDto(updated), cacheAffected };
  });
  if (result.cacheAffected) await cacheDelete('content');
  return result.dto;
}

/** Renders markdown through the same sanitiser used at save time (preview endpoint). */
export function renderPreviewHtml(markdown: string): string {
  return renderMarkdown(markdown);
}

/**
 * Effective public revision of a slug at `now`: published pages, and scheduled
 * pages whose publishAt has passed. Not cached; used by the preview page,
 * the scheduler promotion and tests.
 */
export async function resolvePublicContent(slug: string, now: Date = new Date()): Promise<PublishedContent | null> {
  const rows = await withActor(getDb(), { userId: null, organizationId: null, staff: false }, (tx) =>
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
          or(
            eq(schema.contentPages.status, 'published'),
            and(eq(schema.contentPages.status, 'scheduled'), lte(schema.contentPages.publishAt, now)),
          ),
        ),
      ),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    slug: row.page.slug,
    kind: row.page.kind,
    title: row.rev.title,
    bodyHtml: row.rev.bodyHtmlSanitized ?? renderMarkdown(row.rev.bodyMarkdown),
    bodyMarkdown: row.rev.bodyMarkdown,
    fields: (row.rev.fields as Record<string, unknown> | null) ?? {},
    seo: row.page.seo ?? null,
    publishedAt: (row.page.publishedAt ?? row.page.publishAt)?.toISOString() ?? null,
  };
}

/**
 * Materialises due scheduled publications (status scheduled → published).
 * Intended for the worker scheduler; safe to call repeatedly.
 */
export async function publishDueScheduledPages(now: Date = new Date()): Promise<number> {
  const promoted = await withActor(getDb(), { userId: null, organizationId: null, staff: false, bypass: true }, async (tx) => {
    const rows = await tx
      .update(schema.contentPages)
      .set({ status: 'published', publishedAt: now, publishAt: null, version: sql`${schema.contentPages.version} + 1` })
      .where(and(eq(schema.contentPages.status, 'scheduled'), lte(schema.contentPages.publishAt, now)))
      .returning({ id: schema.contentPages.id, slug: schema.contentPages.slug, publishedRevision: schema.contentPages.publishedRevision });
    for (const row of rows) {
      if (row.publishedRevision !== null) {
        await tx
          .update(schema.contentRevisions)
          .set({ reviewStatus: 'published' })
          .where(and(eq(schema.contentRevisions.pageId, row.id), eq(schema.contentRevisions.revision, row.publishedRevision)));
      }
      await recordAudit(tx, null, {
        actorType: 'system',
        action: 'content.publish',
        entityType: 'content_page',
        entityId: row.id,
        after: { status: 'published', slug: row.slug, publishedRevision: row.publishedRevision, scheduled: true },
      });
    }
    return rows.length;
  });
  if (promoted > 0) await cacheDelete('content');
  return promoted;
}

/** Media picker: only assets approved for public use are listed; uploads arrive in Wave 2. */
export async function listApprovedMedia(identity: RequestIdentity): Promise<MediaAssetDto[]> {
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select({ m: schema.mediaAssets, f: schema.fileObjects })
      .from(schema.mediaAssets)
      .innerJoin(schema.fileObjects, eq(schema.fileObjects.id, schema.mediaAssets.fileId))
      .where(and(eq(schema.mediaAssets.approvedForPublic, true), eq(schema.fileObjects.status, 'clean')))
      .orderBy(asc(schema.mediaAssets.createdAt))
      .limit(200),
  );
  return rows.map((r) => ({
    id: r.m.id,
    fileId: r.m.fileId,
    altText: r.m.altText,
    caption: r.m.caption,
    originalName: r.f.originalName,
    declaredMime: r.f.declaredMime,
    approvedForPublic: r.m.approvedForPublic,
    rightsConfirmed: r.m.rightsConfirmed,
    createdAt: r.m.createdAt.toISOString(),
  }));
}
