import 'server-only';
import { sql } from 'drizzle-orm';
import { referenceFor } from '@simplexd/domain/services';
import type { Transaction } from '@simplexd/db';

/**
 * Allocates the next human-readable reference (e.g. SR-2026-000042) inside the
 * caller's transaction. A transaction-scoped advisory lock serialises
 * allocation per prefix and year, and the caller's insert still relies on the
 * unique constraint on `reference` (retried by `insertWithReferenceRetry`).
 *
 * Must run while the transaction is elevated (bypass), otherwise row-level
 * security would hide other organisations' references and the maximum would
 * be wrong.
 */
export async function allocateReference(
  tx: Transaction,
  prefix: string,
  year: number = new Date().getUTCFullYear(),
): Promise<string> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`reference:${prefix}:${year}`}))`);
  const like = `${prefix}-${year}-%`;
  const res = await tx.execute<{ max: string | null }>(
    sql`SELECT max(reference) AS max FROM service_requests WHERE reference LIKE ${like}`,
  );
  const current = res.rows[0]?.max ?? null;
  const last = current ? Number(current.slice(current.lastIndexOf('-') + 1)) : 0;
  const next = Number.isFinite(last) ? last + 1 : 1;
  return referenceFor(prefix, next, year);
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/**
 * Runs `attempt` with a freshly allocated reference inside a savepoint so a
 * unique-constraint collision (e.g. a reference inserted by a migration or
 * import that did not take the advisory lock) is retried with the next number
 * instead of aborting the surrounding transaction.
 */
export async function insertWithReferenceRetry<T>(
  tx: Transaction,
  prefix: string,
  attempt: (reference: string) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      return await tx.transaction(async (savepoint) => {
        const reference = await allocateReference(savepoint as unknown as Transaction, prefix);
        return attempt(reference);
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}
