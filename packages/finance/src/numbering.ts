import { sql } from 'drizzle-orm';
import type { DbExecutor } from '@simplexd/db';

/**
 * Human-readable document numbers with a per-year sequence: INV-2026-0001,
 * RCT-2026-0001, CN-2026-0001, SXD-… for payment references. The sequence is
 * computed inside the caller's transaction under a transaction-scoped
 * advisory lock, so concurrent issuers never collide; the unique index on the
 * number column is the last line of defence. Must run under a privileged
 * context: the maximum spans every organisation.
 */

export type NumberedTable = 'invoices' | 'receipts' | 'credit_notes';

const PREFIX: Record<NumberedTable, string> = {
  invoices: 'INV',
  receipts: 'RCT',
  credit_notes: 'CN',
};

export async function nextDocumentNumber(
  tx: DbExecutor,
  table: NumberedTable,
  now: Date = new Date(),
): Promise<string> {
  const prefix = PREFIX[table];
  const year = now.getUTCFullYear();
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`docnum:${prefix}:${year}`}))`);
  const like = `${prefix}-${year}-%`;
  const res = await tx.execute<{ max: string | null }>(
    sql`SELECT max(number) AS max FROM ${sql.raw(table)} WHERE number LIKE ${like}`,
  );
  const current = res.rows[0]?.max ?? null;
  const last = current ? Number(current.slice(current.lastIndexOf('-') + 1)) : 0;
  const next = Number.isFinite(last) ? last + 1 : 1;
  return `${prefix}-${year}-${String(next).padStart(4, '0')}`;
}
