import { describe, expect, it } from 'vitest';
import { matchVerification, type AttemptForMatch } from './matching';
import type { VerifyResult } from './types';

const attempt: AttemptForMatch = {
  reference: 'sxd-inv-1-a1',
  amountKobo: 1_500_000n,
  currency: 'NGN',
  status: 'pending',
};

function verification(overrides: Partial<VerifyResult> = {}): VerifyResult {
  return {
    providerStatus: 'success',
    amountKobo: 1_500_000n,
    currency: 'NGN',
    providerReference: 'sxd-inv-1-a1',
    providerTransactionId: '1',
    paidAt: '2026-09-23T10:00:00.000Z',
    channel: 'card',
    feesKobo: 22_500n,
    gatewayResponse: 'Successful',
    environment: 'test',
    raw: {},
    ...overrides,
  };
}

describe('matchVerification', () => {
  it('settles only when status, reference, amount and currency all match', () => {
    const outcome = matchVerification({ attempt, verification: verification() });
    expect(outcome.decision).toBe('settle');
    expect(outcome.targetStatus).toBe('successful');
  });

  it('never settles a mismatched amount, even a larger one', () => {
    const larger = matchVerification({
      attempt,
      verification: verification({ amountKobo: 1_600_000n }),
    });
    expect(larger.decision).toBe('mismatch');
    expect(larger.reasons.join(' ')).toMatch(/amount_mismatch/);
    const smaller = matchVerification({
      attempt,
      verification: verification({ amountKobo: 1_400_000n }),
    });
    expect(smaller.decision).toBe('mismatch');
    const missing = matchVerification({
      attempt,
      verification: verification({ amountKobo: null }),
    });
    expect(missing.decision).toBe('mismatch');
  });

  it('flags currency and reference mismatches', () => {
    const currency = matchVerification({
      attempt,
      verification: verification({ currency: 'USD' }),
    });
    expect(currency.decision).toBe('mismatch');
    expect(currency.reasons.join(' ')).toMatch(/currency_mismatch/);
    const reference = matchVerification({
      attempt,
      verification: verification({ providerReference: 'someone-elses-ref' }),
    });
    expect(reference.decision).toBe('mismatch');
    expect(reference.reasons.join(' ')).toMatch(/reference_mismatch/);
  });

  it('fails abandoned, failed and pre-settlement reversals', () => {
    expect(
      matchVerification({ attempt, verification: verification({ providerStatus: 'failed' }) }),
    ).toMatchObject({
      decision: 'fail',
      targetStatus: 'failed',
    });
    expect(
      matchVerification({ attempt, verification: verification({ providerStatus: 'abandoned' }) }),
    ).toMatchObject({
      decision: 'fail',
      targetStatus: 'abandoned',
    });
    expect(
      matchVerification({ attempt, verification: verification({ providerStatus: 'reversed' }) }),
    ).toMatchObject({
      decision: 'fail',
    });
  });

  it('keeps young pending attempts and marks old ones uncertain', () => {
    const pending = verification({ providerStatus: 'pending', amountKobo: null, currency: null });
    expect(matchVerification({ attempt, verification: pending, ageSeconds: 120 })).toMatchObject({
      decision: 'keep_pending',
    });
    expect(matchVerification({ attempt, verification: pending })).toMatchObject({
      decision: 'keep_pending',
    });
    expect(
      matchVerification({ attempt, verification: pending, ageSeconds: 25 * 3600 }),
    ).toMatchObject({
      decision: 'mark_uncertain',
      targetStatus: 'uncertain',
    });
    const unknown = verification({
      providerStatus: 'unknown',
      amountKobo: null,
      providerReference: null,
    });
    expect(matchVerification({ attempt, verification: unknown, ageSeconds: 10 }).decision).toBe(
      'keep_pending',
    );
    expect(
      matchVerification({
        attempt,
        verification: unknown,
        ageSeconds: 7200,
        uncertainAfterSeconds: 3600,
      }).decision,
    ).toBe('mark_uncertain');
    expect(
      matchVerification({
        attempt: { ...attempt, status: 'uncertain' },
        verification: unknown,
        ageSeconds: 90_000,
      }).decision,
    ).toBe('no_change');
    expect(
      matchVerification({
        attempt: { ...attempt, status: 'initialized' },
        verification: pending,
        ageSeconds: 5,
      }).targetStatus,
    ).toBe('pending');
  });

  it('handles already-settled and final attempts without re-allocating', () => {
    const settled = { ...attempt, status: 'successful' as const };
    expect(matchVerification({ attempt: settled, verification: verification() }).decision).toBe(
      'no_change',
    );
    expect(
      matchVerification({ attempt: settled, verification: verification({ amountKobo: 1n }) })
        .decision,
    ).toBe('mismatch');
    expect(
      matchVerification({
        attempt: settled,
        verification: verification({ providerStatus: 'reversed' }),
      }),
    ).toMatchObject({
      decision: 'reverse',
      targetStatus: 'reversed',
    });
    expect(
      matchVerification({
        attempt: settled,
        verification: verification({ providerStatus: 'failed' }),
      }).decision,
    ).toBe('mismatch');
    expect(
      matchVerification({
        attempt: settled,
        verification: verification({ providerStatus: 'pending' }),
      }).decision,
    ).toBe('no_change');
    const abandoned = { ...attempt, status: 'abandoned' as const };
    expect(matchVerification({ attempt: abandoned, verification: verification() }).decision).toBe(
      'mismatch',
    );
    expect(
      matchVerification({
        attempt: abandoned,
        verification: verification({ providerStatus: 'failed' }),
      }).decision,
    ).toBe('no_change');
  });
});
