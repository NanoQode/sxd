import 'server-only';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FileDto, FileListQuery, Page } from '@simplexd/contracts';
import { applyActorContext, getDb, schema, withActor } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';
import { decideFileAccess, freshMemberships, requireFileAccess } from './access';
import { ctxFor, toFileDto, userIdOf, type FileGrantRow, type ServiceOptions } from './shared';

/** Read models: a single file (view access) and files attached to an entity. */

export async function getFile(identity: RequestIdentity, fileId: string, options: ServiceOptions = {}): Promise<FileDto> {
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const { file } = await requireFileAccess(tx, identity, ctx, fileId, 'view');
    return toFileDto(file);
  });
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!iso || !id) return null;
    const createdAt = new Date(iso);
    return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
  } catch {
    return null;
  }
}

/** Upper bound on files considered per entity; evidence sets beyond this are paged by the evidence module. */
const ENTITY_SCAN_LIMIT = 1000;

/**
 * Files attached to an entity, filtered by the same access policy as
 * downloads (fresh memberships and grants), newest first. Candidate rows are
 * read elevated so that grant-only viewers see files of organisations they
 * do not belong to; the policy then removes everything else before paging.
 */
export async function listFilesForEntity(
  identity: RequestIdentity,
  query: FileListQuery,
  options: ServiceOptions = {},
): Promise<Page<FileDto>> {
  const userId = userIdOf(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    await applyActorContext(tx, { ...ctx, bypass: true });
    try {
      const conditions = [
        eq(schema.fileObjects.entityType, query.entityType),
        eq(schema.fileObjects.entityId, query.entityId),
        isNull(schema.fileObjects.deletedAt),
      ];
      if (query.status) conditions.push(eq(schema.fileObjects.status, query.status));
      const rows = await tx
        .select()
        .from(schema.fileObjects)
        .where(and(...conditions))
        .orderBy(desc(schema.fileObjects.createdAt), desc(schema.fileObjects.id))
        .limit(ENTITY_SCAN_LIMIT);
      const memberships = await freshMemberships(tx, userId);
      const orgIds = new Set(memberships.map((m) => m.organizationId));
      const now = Date.now();
      const grantRows =
        rows.length === 0
          ? []
          : await tx
              .select()
              .from(schema.fileAccessGrants)
              .where(
                and(
                  inArray(
                    schema.fileAccessGrants.fileId,
                    rows.map((r) => r.id),
                  ),
                  isNull(schema.fileAccessGrants.revokedAt),
                ),
              );
      const grantsByFile = new Map<string, FileGrantRow[]>();
      for (const g of grantRows) {
        const applies =
          (!g.expiresAt || g.expiresAt.getTime() > now) &&
          ((g.userId !== null && g.userId === userId) || (g.organizationId !== null && orgIds.has(g.organizationId)));
        if (!applies) continue;
        const list = grantsByFile.get(g.fileId) ?? [];
        list.push(g);
        grantsByFile.set(g.fileId, list);
      }
      const visible = rows.filter((file) =>
        decideFileAccess(identity, { file, grants: grantsByFile.get(file.id) ?? [], memberships }, 'view').allowed,
      );
      const cursor = decodeCursor(query.cursor);
      const after = cursor
        ? visible.filter(
            (f) =>
              f.createdAt.getTime() < cursor.createdAt.getTime() ||
              (f.createdAt.getTime() === cursor.createdAt.getTime() && f.id < cursor.id),
          )
        : visible;
      const items = after.slice(0, query.limit);
      const tail = items[items.length - 1];
      return {
        items: items.map(toFileDto),
        nextCursor: after.length > query.limit && tail ? encodeCursor(tail.createdAt, tail.id) : null,
        total: visible.length,
      };
    } finally {
      await applyActorContext(tx, { ...ctx, bypass: false });
    }
  });
}
