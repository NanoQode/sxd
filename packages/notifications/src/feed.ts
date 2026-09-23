import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { schema, withActor, type ActorContext } from '@simplexd/db';
import type { Db } from './types';

/**
 * In-app feed for the signed-in user. Queries run under the caller's actor
 * context so row-level security scopes rows to `user_id = app.user_id()`;
 * the explicit filter keeps intent obvious.
 */

export interface NotificationDto {
  id: string;
  category: string;
  kind: string;
  title: string;
  body: string | null;
  linkPath: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface FeedPage {
  items: NotificationDto[];
  nextCursor: string | null;
  unreadCount: number;
}

type Row = typeof schema.notifications.$inferSelect;

const toDto = (r: Row): NotificationDto => ({
  id: r.id,
  category: r.category,
  kind: r.kind,
  title: r.title,
  body: r.body,
  linkPath: r.linkPath,
  entityType: r.entityType,
  entityId: r.entityId,
  readAt: r.readAt ? r.readAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(),
});

function encodeCursor(r: Row): string {
  return Buffer.from(`${r.createdAt.toISOString()}|${r.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = iso ? new Date(iso) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

export async function listNotifications(
  db: Db,
  ctx: ActorContext,
  query: { cursor?: string; limit?: number; unreadOnly?: boolean } = {},
): Promise<FeedPage> {
  const userId = ctx.userId;
  if (!userId) return { items: [], nextCursor: null, unreadCount: 0 };
  const limit = Math.min(100, Math.max(1, query.limit ?? 25));
  const cursor = decodeCursor(query.cursor);
  return withActor(db, ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, userId),
          query.unreadOnly ? isNull(schema.notifications.readAt) : undefined,
          cursor
            ? or(
                lt(schema.notifications.createdAt, cursor.createdAt),
                and(
                  eq(schema.notifications.createdAt, cursor.createdAt),
                  lt(schema.notifications.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toDto),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
      unreadCount: await countUnread(tx, userId),
    };
  });
}

async function countUnread(
  tx: Parameters<Parameters<typeof withActor>[2]>[0],
  userId: string,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<string>`count(*)::text` })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
  return Number(row?.n ?? 0);
}

export async function unreadCount(db: Db, ctx: ActorContext): Promise<number> {
  if (!ctx.userId) return 0;
  return withActor(db, ctx, (tx) => countUnread(tx, ctx.userId!));
}

export async function markNotificationRead(
  db: Db,
  ctx: ActorContext,
  id: string,
): Promise<NotificationDto | null> {
  if (!ctx.userId) return null;
  return withActor(db, ctx, async (tx) => {
    const [row] = await tx
      .update(schema.notifications)
      .set({ readAt: sql`coalesce(${schema.notifications.readAt}, now())` })
      .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, ctx.userId!)))
      .returning();
    return row ? toDto(row) : null;
  });
}

export async function markAllNotificationsRead(db: Db, ctx: ActorContext): Promise<number> {
  if (!ctx.userId) return 0;
  return withActor(db, ctx, async (tx) => {
    const rows = await tx
      .update(schema.notifications)
      .set({ readAt: new Date() })
      .where(and(eq(schema.notifications.userId, ctx.userId!), isNull(schema.notifications.readAt)))
      .returning({ id: schema.notifications.id });
    return rows.length;
  });
}
