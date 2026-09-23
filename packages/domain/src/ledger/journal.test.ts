import { describe, expect, it } from 'vitest';
import { ACCOUNTS, CHART_OF_ACCOUNTS, accountDefinition, isAccountCode, isRevenueAccount } from './accounts';
import {
  JournalError,
  assertBalanced,
  balanceEffect,
  credit,
  debit,
  isBalanced,
  journalTotals,
  netForAccount,
  reverse,
  type JournalDraft,
} from './journal';

const settled: JournalDraft = {
  businessEventRef: 'payment_attempt:pa-1:settled',
  description: 'Gateway payment settled',
  sourceType: 'payment_attempt',
  sourceId: 'pa-1',
  currency: 'NGN',
  organizationId: 'org-1',
  lines: [
    debit(ACCOUNTS.GATEWAY_CLEARING, 100_000n, { entityType: 'payment_attempt', entityId: 'pa-1' }),
    credit(ACCOUNTS.CUSTOMER_RECEIVABLES, 100_000n, { entityType: 'invoice', entityId: 'inv-1' }),
  ],
};

describe('chart of accounts', () => {
  it('matches the seeded chart codes and classifies revenue accounts', () => {
    expect(CHART_OF_ACCOUNTS.map((a) => a.code)).toEqual([
      '1000', '1100', '1200', '1300', '1400', '2000', '2100', '2200', '2300', '2400', '2500', '3000',
      '4000', '4100', '4200', '4300', '5000', '5100', '5200', '5300',
    ]);
    expect(isAccountCode('2100')).toBe(true);
    expect(isAccountCode('9999')).toBe(false);
    expect(accountDefinition(ACCOUNTS.RENT_COLLECTED_PAYABLE_TO_OWNERS).type).toBe('liability');
    expect(isRevenueAccount(ACCOUNTS.RENT_COLLECTED_PAYABLE_TO_OWNERS)).toBe(false);
    expect(isRevenueAccount(ACCOUNTS.MANAGEMENT_FEE_REVENUE)).toBe(true);
  });
});

describe('assertBalanced', () => {
  it('accepts a balanced draft and reports totals', () => {
    expect(assertBalanced(settled)).toEqual({ debitKobo: 100_000n, creditKobo: 100_000n, lineCount: 2 });
    expect(isBalanced(settled)).toBe(true);
  });

  it('throws with detail when debits and credits differ', () => {
    const unbalanced: JournalDraft = {
      ...settled,
      lines: [debit(ACCOUNTS.GATEWAY_CLEARING, 100_000n), credit(ACCOUNTS.CUSTOMER_RECEIVABLES, 99_000n)],
    };
    expect(() => assertBalanced(unbalanced)).toThrow(/not balanced: debits 100000 ≠ credits 99000 \(difference 1000\)/);
    try {
      assertBalanced(unbalanced);
    } catch (error) {
      expect(error).toBeInstanceOf(JournalError);
      expect((error as JournalError).details).toMatchObject({ differenceKobo: '1000' });
    }
    expect(isBalanced(unbalanced)).toBe(false);
  });

  it('rejects malformed lines, accounts, currency and references', () => {
    expect(() => assertBalanced({ ...settled, lines: [settled.lines[0]!] })).toThrow(/at least two lines/);
    expect(() =>
      assertBalanced({
        ...settled,
        lines: [
          { accountCode: ACCOUNTS.BANK, debitKobo: 1n, creditKobo: 1n },
          credit(ACCOUNTS.CUSTOMER_RECEIVABLES, 0n),
        ],
      }),
    ).toThrow(/exactly one of debit or credit/);
    expect(() =>
      assertBalanced({ ...settled, lines: [debit(ACCOUNTS.BANK, 0n), credit(ACCOUNTS.CUSTOMER_RECEIVABLES, 0n)] }),
    ).toThrow(/positive integer kobo/);
    expect(() =>
      assertBalanced({ ...settled, lines: [debit(ACCOUNTS.BANK, -5n), credit(ACCOUNTS.CUSTOMER_RECEIVABLES, -5n)] }),
    ).toThrow(/positive integer kobo/);
    expect(() =>
      assertBalanced({
        ...settled,
        lines: [debit('7777' as typeof ACCOUNTS.BANK, 5n), credit(ACCOUNTS.CUSTOMER_RECEIVABLES, 5n)],
      }),
    ).toThrow(/unknown account 7777/);
    expect(() => assertBalanced({ ...settled, currency: 'naira' })).toThrow(/three-letter/);
    expect(() => assertBalanced({ ...settled, businessEventRef: ' ' })).toThrow(/businessEventRef/);
  });
});

describe('reverse', () => {
  it('mirrors every line, references the original and keeps the source', () => {
    const reversal = reverse(settled, 'payment_attempt:pa-1:reversed', 'chargeback lost');
    expect(reversal.businessEventRef).toBe('payment_attempt:pa-1:reversed');
    expect(reversal.reversalOfBusinessEventRef).toBe(settled.businessEventRef);
    expect(reversal.description).toContain('Reversal of payment_attempt:pa-1:settled');
    expect(reversal.sourceType).toBe('payment_attempt');
    expect(reversal.sourceId).toBe('pa-1');
    expect(reversal.organizationId).toBe('org-1');
    expect(reversal.lines).toEqual([
      { accountCode: ACCOUNTS.GATEWAY_CLEARING, creditKobo: 100_000n, entityType: 'payment_attempt', entityId: 'pa-1' },
      { accountCode: ACCOUNTS.CUSTOMER_RECEIVABLES, debitKobo: 100_000n, entityType: 'invoice', entityId: 'inv-1' },
    ]);
    expect(journalTotals(reversal)).toEqual(journalTotals(settled));
    expect(netForAccount(reversal, ACCOUNTS.GATEWAY_CLEARING)).toBe(-netForAccount(settled, ACCOUNTS.GATEWAY_CLEARING));
    // the original draft is untouched
    expect(settled.lines[0]!.debitKobo).toBe(100_000n);
  });

  it('requires a new reference and a reason', () => {
    expect(() => reverse(settled, settled.businessEventRef, 'oops')).toThrow(/different businessEventRef/);
    expect(() => reverse(settled, 'x', '')).toThrow(/reason/);
  });
});

describe('balance effects', () => {
  it('reads the effect on normal balances', () => {
    expect(balanceEffect(settled, ACCOUNTS.GATEWAY_CLEARING)).toBe(100_000n);
    expect(balanceEffect(settled, ACCOUNTS.CUSTOMER_RECEIVABLES)).toBe(-100_000n);
    const liability: JournalDraft = {
      ...settled,
      lines: [debit(ACCOUNTS.RENT_RECEIVABLE_ON_BEHALF_OF_OWNERS, 1n), credit(ACCOUNTS.RENT_COLLECTED_PAYABLE_TO_OWNERS, 1n)],
    };
    expect(balanceEffect(liability, ACCOUNTS.RENT_COLLECTED_PAYABLE_TO_OWNERS)).toBe(1n);
  });
});
