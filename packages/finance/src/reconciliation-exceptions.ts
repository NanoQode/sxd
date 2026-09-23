import { and, eq, sql } from 'drizzle-orm';
import { schema, type DbExecutor } from '@simplexd/db';

/**
 * Reconciliation exceptions are appended to the open `reconciliations` row of
 * the day (kind `payments`). The table is privileged-only, so callers run
 * under the system context. Exceptions are never silently dropped: a closed
 * period gets a fresh row rather than a mutation of history.
 */

export interface ReconciliationException {
  code: string;
  message: string;
  entityType?: string;
  entityId?: string;
}

export const RECONCILIATION_KIND = 'payments';

export async function openReconciliationForDay(
  tx: DbExecutor,
  day: string,
): Promise<typeof schema.reconciliations.$inferSelect> {
  const [existing] = await tx
    .select()
    .from(schema.reconciliations)
    .where(
      and(
        eq(schema.reconciliations.kind, RECONCILIATION_KIND),
        eq(schema.reconciliations.periodStart, day),
        sql`${schema.reconciliations.status} in ('open','in_progress','exceptions')`,
      ),
    )
    .for('update');
  if (existing) return existing;
  const [created] = await tx
    .insert(schema.reconciliations)
    .values({
      kind: RECONCILIATION_KIND,
      periodStart: day,
      periodEnd: day,
      status: 'open',
      summary: {},
      exceptions: [],
    })
    .returning();
  return created!;
}

export async function addReconciliationException(
  tx: DbExecutor,
  exception: ReconciliationException,
  now: Date = new Date(),
): Promise<string> {
  const day = now.toISOString().slice(0, 10);
  const row = await openReconciliationForDay(tx, day);
  const existing = row.exceptions ?? [];
  const duplicate = existing.some(
    (e) =>
      e.code === exception.code &&
      e.entityType === exception.entityType &&
      e.entityId === exception.entityId,
  );
  if (!duplicate) {
    const entry: ReconciliationException = { code: exception.code, message: exception.message.slice(0, 1000) };
    if (exception.entityType !== undefined) entry.entityType = exception.entityType;
    if (exception.entityId !== undefined) entry.entityId = exception.entityId;
    await tx
      .update(schema.reconciliations)
      .set({ exceptions: [...existing, entry], status: 'exceptions' })
      .where(eq(schema.reconciliations.id, row.id));
  }
  return row.id;
}
