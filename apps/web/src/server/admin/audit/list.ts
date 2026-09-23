import 'server-only';
import { and, desc, eq, gte, lte, or, sql, type SQL } from 'drizzle-orm';
import { ApiError, type AuditEventDto, type AuditListQuery } from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import { authorize, transact, type AdminContext } from '../context';

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [ts, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(ts ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) throw new ApiError('validation_failed', 'invalid cursor');
  return { createdAt, id };
}

/** Read-only, cursor-paginated audit log. Entries are immutable by trigger. */
export async function listAuditEvents(
  ctx: AdminContext,
  query: AuditListQuery,
): Promise<{ items: AuditEventDto[]; nextCursor: string | null }> {
  authorize(ctx, 'audit.read');
  return transact(ctx, async (tx) => {
    const clauses: SQL[] = [];
    if (query.actorUserId) clauses.push(eq(schema.auditEvents.actorUserId, query.actorUserId));
    if (query.entityType) clauses.push(eq(schema.auditEvents.entityType, query.entityType));
    if (query.entityId) clauses.push(eq(schema.auditEvents.entityId, query.entityId));
    if (query.action) clauses.push(sql`${schema.auditEvents.action} ilike ${`${query.action.replace(/[%_]/g, '')}%`}`);
    if (query.from) clauses.push(gte(schema.auditEvents.createdAt, new Date(query.from)));
    if (query.to) clauses.push(lte(schema.auditEvents.createdAt, new Date(query.to)));
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      clauses.push(
        or(
          sql`${schema.auditEvents.createdAt} < ${c.createdAt}`,
          and(eq(schema.auditEvents.createdAt, c.createdAt), sql`${schema.auditEvents.id} < ${c.id}::uuid`),
        )!,
      );
    }
    const rows = await tx
      .select({ e: schema.auditEvents, actorName: schema.user.name })
      .from(schema.auditEvents)
      .leftJoin(schema.user, eq(schema.user.id, schema.auditEvents.actorUserId))
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(schema.auditEvents.createdAt), desc(schema.auditEvents.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(({ e, actorName }) => ({
        id: e.id,
        actorType: e.actorType,
        actorUserId: e.actorUserId,
        actorName,
        organizationId: e.organizationId,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        before: e.before ?? null,
        after: e.after ?? null,
        reason: e.reason,
        correlationId: e.correlationId,
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.e.createdAt, last.e.id) : null,
    };
  });
}

/** Distinct entity types and actions seen, for filter controls. */
export async function auditFilterOptions(ctx: AdminContext): Promise<{ entityTypes: string[]; actions: string[] }> {
  authorize(ctx, 'audit.read');
  return transact(ctx, async (tx) => {
    const [types, actions] = await Promise.all([
      tx.selectDistinct({ v: schema.auditEvents.entityType }).from(schema.auditEvents).orderBy(schema.auditEvents.entityType),
      tx.selectDistinct({ v: schema.auditEvents.action }).from(schema.auditEvents).orderBy(schema.auditEvents.action),
    ]);
    return { entityTypes: types.map((t) => t.v), actions: actions.map((a) => a.v) };
  });
}
