import { eq, inArray, sql } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { schema, type DbExecutor } from '@simplexd/db';
import { assertBalanced, type JournalDraft } from '@simplexd/domain/ledger';

/**
 * Persists a balanced journal draft: maps account codes to ledger_accounts
 * ids, inserts the journal and its lines in one statement sequence and relies
 * on the unique `business_event_ref` to make double-posting impossible. The
 * deferred database trigger re-checks the balance at commit. Journals are
 * privileged-only tables, so callers run under the system context after the
 * business action was authorised.
 */

export class JournalAlreadyPostedError extends Error {
  override readonly name = 'JournalAlreadyPostedError';
  constructor(readonly businessEventRef: string) {
    super(`journal ${businessEventRef} was already posted`);
  }
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

export async function accountIdsByCode(
  tx: DbExecutor,
  codes: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(codes)];
  const rows = await tx
    .select({ id: schema.ledgerAccounts.id, code: schema.ledgerAccounts.code })
    .from(schema.ledgerAccounts)
    .where(inArray(schema.ledgerAccounts.code, unique));
  const map = new Map(rows.map((r) => [r.code, r.id]));
  for (const code of unique) {
    if (!map.has(code)) {
      throw new ApiError('internal_error', `ledger account ${code} is not seeded`, {
        details: { code },
      });
    }
  }
  return map;
}

export interface PostedJournal {
  id: string;
  businessEventRef: string;
}

export async function findJournalByRef(
  tx: DbExecutor,
  businessEventRef: string,
): Promise<PostedJournal | null> {
  const [row] = await tx
    .select({ id: schema.journals.id, businessEventRef: schema.journals.businessEventRef })
    .from(schema.journals)
    .where(eq(schema.journals.businessEventRef, businessEventRef));
  return row ?? null;
}

export async function postJournal(
  tx: DbExecutor,
  draft: JournalDraft,
  options: { postedBy?: string | null } = {},
): Promise<PostedJournal> {
  assertBalanced(draft);
  const accounts = await accountIdsByCode(
    tx,
    draft.lines.map((l) => l.accountCode),
  );
  let reversalOfJournalId: string | null = null;
  if (draft.reversalOfBusinessEventRef) {
    const original = await findJournalByRef(tx, draft.reversalOfBusinessEventRef);
    if (!original) {
      throw new ApiError('conflict', `cannot reverse ${draft.reversalOfBusinessEventRef}: journal not found`);
    }
    reversalOfJournalId = original.id;
  }
  let journalId: string;
  try {
    const [row] = await tx
      .insert(schema.journals)
      .values({
        organizationId: draft.organizationId ?? null,
        businessEventRef: draft.businessEventRef,
        description: draft.description,
        sourceType: draft.sourceType,
        sourceId: draft.sourceId,
        postedBy: options.postedBy ?? null,
        reversalOfJournalId,
        estateSegment: draft.estateSegment ?? null,
      })
      .returning({ id: schema.journals.id });
    journalId = row!.id;
  } catch (err) {
    if (isUniqueViolation(err)) throw new JournalAlreadyPostedError(draft.businessEventRef);
    throw err;
  }
  await tx.insert(schema.journalLines).values(
    draft.lines.map((line, index) => ({
      journalId,
      lineNo: index + 1,
      accountId: accounts.get(line.accountCode)!,
      debitKobo: line.debitKobo ?? 0n,
      creditKobo: line.creditKobo ?? 0n,
      currency: draft.currency,
      organizationId: line.organizationId ?? draft.organizationId ?? null,
      entityType: line.entityType ?? null,
      entityId: line.entityId ?? null,
      memo: line.memo ?? null,
    })),
  );
  return { id: journalId, businessEventRef: draft.businessEventRef };
}

/** Sum of debits and credits over every posted line; equal when the ledger balances. */
export async function ledgerTotals(tx: DbExecutor): Promise<{ debitKobo: bigint; creditKobo: bigint }> {
  const res = await tx.execute<{ d: string; c: string }>(
    sql`select coalesce(sum(debit_kobo),0)::text as d, coalesce(sum(credit_kobo),0)::text as c from journal_lines`,
  );
  const row = res.rows[0];
  return { debitKobo: BigInt(row?.d ?? '0'), creditKobo: BigInt(row?.c ?? '0') };
}
