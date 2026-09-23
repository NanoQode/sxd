import type { Kobo } from '../money';
import { accountDefinition, isAccountCode, type AccountCode } from './accounts';

/**
 * Journal drafts. A posted journal is immutable: corrections are reversing
 * journals built with `reverse()`, never edits. Every journal carries a unique
 * business-event reference (`journals.business_event_ref`) so the same event
 * can never be posted twice.
 */

export interface JournalLineDraft {
  accountCode: AccountCode;
  debitKobo?: Kobo;
  creditKobo?: Kobo;
  entityType?: string;
  entityId?: string;
  memo?: string;
  organizationId?: string;
}

export interface JournalDraft {
  /** Unique per business event, e.g. `payment_attempt:<id>:settled`. */
  businessEventRef: string;
  description: string;
  sourceType: string;
  sourceId: string;
  currency: string;
  organizationId?: string;
  estateSegment?: string;
  /** Set on reversing journals; the application maps it to `reversal_of_journal_id`. */
  reversalOfBusinessEventRef?: string;
  lines: JournalLineDraft[];
}

export interface JournalTotals {
  debitKobo: Kobo;
  creditKobo: Kobo;
  lineCount: number;
}

export class JournalError extends Error {
  override readonly name = 'JournalError';
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.details = details;
  }
}

export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function assertCurrency(currency: string): string {
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw new JournalError(`currency must be a three-letter ISO code, received "${String(currency)}"`, {
      currency,
    });
  }
  return currency;
}

export function assertPositiveKobo(label: string, amount: Kobo): Kobo {
  if (typeof amount !== 'bigint') {
    throw new JournalError(`${label} must be a bigint of integer kobo`, { label });
  }
  if (amount <= 0n) throw new JournalError(`${label} must be positive, received ${amount}`, { label, amount });
  return amount;
}

export function assertNonNegativeKobo(label: string, amount: Kobo): Kobo {
  if (typeof amount !== 'bigint') {
    throw new JournalError(`${label} must be a bigint of integer kobo`, { label });
  }
  if (amount < 0n) throw new JournalError(`${label} cannot be negative, received ${amount}`, { label, amount });
  return amount;
}

export interface LineExtras {
  entityType?: string;
  entityId?: string;
  memo?: string;
  organizationId?: string;
}

export function debit(accountCode: AccountCode, amount: Kobo, extras: LineExtras = {}): JournalLineDraft {
  return { accountCode, debitKobo: amount, ...extras };
}

export function credit(accountCode: AccountCode, amount: Kobo, extras: LineExtras = {}): JournalLineDraft {
  return { accountCode, creditKobo: amount, ...extras };
}

export function journalTotals(draft: JournalDraft): JournalTotals {
  let debitKobo = 0n;
  let creditKobo = 0n;
  for (const line of draft.lines) {
    debitKobo += line.debitKobo ?? 0n;
    creditKobo += line.creditKobo ?? 0n;
  }
  return { debitKobo, creditKobo, lineCount: draft.lines.length };
}

/**
 * Throws a `JournalError` with detail when the draft could not be posted:
 * missing reference, fewer than two lines, a line with both or neither side,
 * non-positive amounts, unknown accounts, bad currency or debits ≠ credits.
 */
export function assertBalanced(draft: JournalDraft): JournalTotals {
  if (!draft.businessEventRef || draft.businessEventRef.trim().length === 0) {
    throw new JournalError('journal needs a businessEventRef');
  }
  if (!draft.description || draft.description.trim().length === 0) {
    throw new JournalError('journal needs a description', { businessEventRef: draft.businessEventRef });
  }
  assertCurrency(draft.currency);
  if (draft.lines.length < 2) {
    throw new JournalError(`journal ${draft.businessEventRef} must have at least two lines`, {
      businessEventRef: draft.businessEventRef,
      lineCount: draft.lines.length,
    });
  }
  draft.lines.forEach((line, index) => {
    if (!isAccountCode(line.accountCode)) {
      throw new JournalError(`line ${index + 1} of ${draft.businessEventRef} uses unknown account ${String(line.accountCode)}`, {
        businessEventRef: draft.businessEventRef,
        lineNo: index + 1,
      });
    }
    const hasDebit = line.debitKobo !== undefined;
    const hasCredit = line.creditKobo !== undefined;
    if (hasDebit === hasCredit) {
      throw new JournalError(`line ${index + 1} of ${draft.businessEventRef} must have exactly one of debit or credit`, {
        businessEventRef: draft.businessEventRef,
        lineNo: index + 1,
      });
    }
    const amount = hasDebit ? line.debitKobo! : line.creditKobo!;
    if (typeof amount !== 'bigint' || amount <= 0n) {
      throw new JournalError(`line ${index + 1} of ${draft.businessEventRef} must carry a positive integer kobo amount`, {
        businessEventRef: draft.businessEventRef,
        lineNo: index + 1,
        amount: typeof amount === 'bigint' ? amount.toString() : String(amount),
      });
    }
  });
  const totals = journalTotals(draft);
  if (totals.debitKobo !== totals.creditKobo) {
    throw new JournalError(
      `journal ${draft.businessEventRef} is not balanced: debits ${totals.debitKobo} ≠ credits ${totals.creditKobo} (difference ${totals.debitKobo - totals.creditKobo})`,
      {
        businessEventRef: draft.businessEventRef,
        debitKobo: totals.debitKobo.toString(),
        creditKobo: totals.creditKobo.toString(),
        differenceKobo: (totals.debitKobo - totals.creditKobo).toString(),
      },
    );
  }
  return totals;
}

export function isBalanced(draft: JournalDraft): boolean {
  try {
    assertBalanced(draft);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the reversing journal for a posted journal: every debit becomes a
 * credit of the same amount on the same account and vice versa. The original
 * is never modified; the reversal references it.
 */
export function reverse(journal: JournalDraft, ref: string, reason: string): JournalDraft {
  assertBalanced(journal);
  if (!ref || ref.trim().length === 0) throw new JournalError('reversal needs a businessEventRef');
  if (ref === journal.businessEventRef) {
    throw new JournalError('reversal must use a different businessEventRef than the original', {
      businessEventRef: ref,
    });
  }
  if (!reason || reason.trim().length === 0) throw new JournalError('reversal needs a reason');
  const lines: JournalLineDraft[] = journal.lines.map((line) => {
    const { debitKobo, creditKobo, ...rest } = line;
    return debitKobo !== undefined ? { ...rest, creditKobo: debitKobo } : { ...rest, debitKobo: creditKobo! };
  });
  const reversal: JournalDraft = {
    businessEventRef: ref,
    description: `Reversal of ${journal.businessEventRef}: ${reason}`,
    sourceType: journal.sourceType,
    sourceId: journal.sourceId,
    currency: journal.currency,
    reversalOfBusinessEventRef: journal.businessEventRef,
    lines,
  };
  if (journal.organizationId !== undefined) reversal.organizationId = journal.organizationId;
  if (journal.estateSegment !== undefined) reversal.estateSegment = journal.estateSegment;
  assertBalanced(reversal);
  return reversal;
}

/** Sum of lines for one account (debits positive, credits negative) — handy for tests and previews. */
export function netForAccount(draft: JournalDraft, accountCode: AccountCode): Kobo {
  let net = 0n;
  for (const line of draft.lines) {
    if (line.accountCode !== accountCode) continue;
    net += (line.debitKobo ?? 0n) - (line.creditKobo ?? 0n);
  }
  return net;
}

/** Signed effect on the account's normal balance (positive = balance grows). */
export function balanceEffect(draft: JournalDraft, accountCode: AccountCode): Kobo {
  const net = netForAccount(draft, accountCode);
  return accountDefinition(accountCode).normalBalance === 'debit' ? net : -net;
}
