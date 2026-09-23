import { describe, expect, it } from 'vitest';
import {
  AllocationError,
  invoiceBalance,
  planAllocation,
  planCreditNoteApplication,
} from './allocation';

const issued = {
  totalKobo: 1_075_000n,
  amountPaidKobo: 0n,
  amountCreditedKobo: 0n,
  status: 'issued' as const,
};

describe('invoiceBalance', () => {
  it('subtracts payments and credits and never goes negative', () => {
    expect(invoiceBalance(issued)).toBe(1_075_000n);
    expect(
      invoiceBalance({ ...issued, amountPaidKobo: 75_000n, amountCreditedKobo: 1_000_000n }),
    ).toBe(0n);
    expect(invoiceBalance({ ...issued, amountPaidKobo: 2_000_000n })).toBe(0n);
  });
});

describe('planAllocation', () => {
  it('allocates a partial payment', () => {
    const plan = planAllocation({ invoice: issued, amountKobo: 500_000n });
    expect(plan).toEqual({
      allocatedKobo: 500_000n,
      overpaymentKobo: 0n,
      newStatus: 'partially_paid',
      receiptRequired: true,
      newAmountPaidKobo: 500_000n,
      remainingBalanceKobo: 575_000n,
    });
  });

  it('completes the invoice on an exact payment and from partially paid', () => {
    expect(planAllocation({ invoice: issued, amountKobo: 1_075_000n }).newStatus).toBe('paid');
    const partial = { ...issued, amountPaidKobo: 500_000n, status: 'partially_paid' as const };
    const plan = planAllocation({ invoice: partial, amountKobo: 575_000n });
    expect(plan.newStatus).toBe('paid');
    expect(plan.newAmountPaidKobo).toBe(1_075_000n);
    expect(plan.remainingBalanceKobo).toBe(0n);
    expect(
      planAllocation({ invoice: { ...issued, status: 'overdue' }, amountKobo: 1n }).newStatus,
    ).toBe('partially_paid');
  });

  it('never allocates more than the balance; the excess is an overpayment', () => {
    const plan = planAllocation({ invoice: issued, amountKobo: 1_200_000n });
    expect(plan.allocatedKobo).toBe(1_075_000n);
    expect(plan.overpaymentKobo).toBe(125_000n);
    expect(plan.newStatus).toBe('paid');
    const credited = { ...issued, amountCreditedKobo: 75_000n };
    const withCredit = planAllocation({ invoice: credited, amountKobo: 1_075_000n });
    expect(withCredit.allocatedKobo).toBe(1_000_000n);
    expect(withCredit.overpaymentKobo).toBe(75_000n);
  });

  it('treats money for an already paid invoice as a deposit with nothing to allocate', () => {
    const paid = { ...issued, amountPaidKobo: 1_075_000n, status: 'paid' as const };
    const plan = planAllocation({ invoice: paid, amountKobo: 10_000n });
    expect(plan.allocatedKobo).toBe(0n);
    expect(plan.overpaymentKobo).toBe(10_000n);
    expect(plan.receiptRequired).toBe(false);
    expect(plan.newStatus).toBe('paid');
  });

  it('rejects draft or void invoices and non-positive amounts', () => {
    expect(() =>
      planAllocation({ invoice: { ...issued, status: 'draft' }, amountKobo: 1n }),
    ).toThrow(AllocationError);
    expect(() =>
      planAllocation({ invoice: { ...issued, status: 'void' }, amountKobo: 1n }),
    ).toThrow(/cannot receive an allocation/);
    expect(() => planAllocation({ invoice: issued, amountKobo: 0n })).toThrow(/positive/);
    expect(() => planAllocation({ invoice: issued, amountKobo: -1n })).toThrow(/positive/);
  });
});

describe('planCreditNoteApplication', () => {
  it('credits up to the balance and may complete the invoice', () => {
    const plan = planCreditNoteApplication({ invoice: issued, amountKobo: 75_000n });
    expect(plan).toEqual({
      creditedKobo: 75_000n,
      newAmountCreditedKobo: 75_000n,
      newStatus: 'issued',
      remainingBalanceKobo: 1_000_000n,
    });
    const full = planCreditNoteApplication({
      invoice: { ...issued, amountPaidKobo: 1_000_000n, status: 'partially_paid' },
      amountKobo: 75_000n,
    });
    expect(full.newStatus).toBe('paid');
    expect(() => planCreditNoteApplication({ invoice: issued, amountKobo: 2_000_000n })).toThrow(
      /exceeds the invoice balance/,
    );
    expect(() =>
      planCreditNoteApplication({ invoice: { ...issued, status: 'paid' }, amountKobo: 1n }),
    ).toThrow(/cannot be credited/);
  });
});
