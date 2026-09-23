import 'server-only';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
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

/**
 * Files attached to an entity, filtered by the same access policy as
 * downloads (fresh memberships and grants), newest first. The candidate rows
 * are read elevated so that grant-only viewers see files of organisations
 * they do not belong to; the policy then removes everything else.
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
      const cursor = decodeCursor(query.cursor);
      const conditions = [
        eq(schema.fileObjects.entityType, query.entityType),
        eq(schema.fileObjects.entityId, query.entityId),
        isNull(schema.fileObjects.deletedAt),
      ];
      if (query.status) conditions.push(eq(schema.fileObjects.status, query.status));
      if (cursor) {
        conditions.push(
          or(
            lt(schema.fileObjects.createdAt, cursor.createdAt),
            and(eq(schema.fileObjects.createdAt, cursor.createdAt), lt(schema.fileObjects.id, cursor.id)),
          )!,
        );
      }
      const memberships = await freshMemberships(tx, userId);
      const orgIds = new Set(memberships.map((m) => m.organizationId));
      const now = Date.now();
      const visible: Array<typeof schema.fileObjects.$inferSelect> = [];
      let lastSeen: { createdAt: Date; id: string } | null = null;
      let exhausted = false;
      let batchCursor = cursor;
      // Scan in batches until a page is full: access is decided per row.
      while (visible.length <= query.limit && !exhausted) {
        const batchConditions = [...conditions];
        if (batchCursor && batchCursor !== cursor) {
          batchConditions.push(
            or(
              lt(schema.fileObjects.createdAt, batchCursor.createdAt),
              and(eq(schema.fileObjects.createdAt, batchCursor.createdAt), lt(schema.fileObjects.id, batchCursor.id)),
            )!,
          );
        }
        const rows = await tx
          .select()
          .from(schema.fileObjects)
          .where(and(...batchConditions))
          .orderBy(desc(schema.fileObjects.createdAt), desc(schema.fileObjects.id))
          .limit(query.limit + 1);
        if (rows.length === 0) break;
        exhausted = rows.length <= query.limit;
        for (const file of rows) {
          const grantRows = await tx
            .select()
            .from(schema.fileAccessGrants)
            .where(and(eq(schema.fileAccessGrants.fileId, file.id), isNull(schema.fileAccessGrants.revokedAt)));
          const grants: FileGrantRow[] = grantRows.filter(
            (g) =>
              (!g.expiresAt || g.expiresAt.getTime() > now) &&
              ((g.userId !== null && g.userId === userId) || (g.organizationId !== null && orgIds.has(g.organizationId))),
          );
          if (decideFileAccess(identity, { file, grants, memberships }, 'view').allowed) visible.push(file);
          lastSeen = { createdAt: file.createdAt, id: file.id };
          if (visible.length > query.limit) break;
        }
        batchCursor = lastSeen;
      }
      const items = visible.slice(0, query.limit);
      const hasMore = visible.length > query.limit;
      const tail = items[items.length - 1];
      return {
        items: items.map(toFileDto),
        nextCursor: hasMore && tail ? encodeCursor(tail.createdAt, tail.id) : null,
      };
    } finally {
      await applyActorContext(tx, { ...ctx, bypass: false });
    }
  });
}
