import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/** Keyset cursor (timestamp + id) for stable pagination over activity-style lists. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso, id] = raw.split('|');
    if (!iso || !id) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * "Rows strictly after the cursor" for a (timestamp DESC, id DESC) ordering.
 * PostgreSQL keeps microseconds while JavaScript dates keep milliseconds, so the
 * comparison truncates the column to milliseconds to match the encoded cursor.
 */
export function keysetAfter(
  timestampCol: PgColumn,
  idCol: PgColumn,
  cursor: { createdAt: Date; id: string },
): SQL {
  return sql`(date_trunc('milliseconds', ${timestampCol}) < ${cursor.createdAt} OR (date_trunc('milliseconds', ${timestampCol}) = ${cursor.createdAt} AND ${idCol} < ${cursor.id}))`;
}
