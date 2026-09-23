import { describe, expect, it } from 'vitest';
import { bpsOf } from '../money';
import { ACCOUNTS, isRevenueAccount } from './accounts';
import { assertBalanced, netForAccount, type JournalDraft } from './journal';
import {
  bankTransferConfirmed,
  chargebackLost,
  chargebackOpened,
  chargebackWon,
  computeManagementFee,
  creditNoteIssued,
  gatewayPaymentSettled,
  gatewaySettlementToBank,
  invoiceIssued,
  maintenanceExpenseRecovered,
  maintenanceExpenseRecoverable,
  managementFeeFromCollectedRent,
  ownerDistributionApproved,
  ownerPayoutSettled,
  partnerFeeAccrued,
  refundApproved,
  refundSettled,
  revenueAccountForInvoiceKind,
  revenueRecognized,
  taxRemitted,
  taxWithheld,
} from './postings';

const serviceInvoice = {
  id: 'inv-1',
  number: 'SXD-0001',
  organizationId: 'org-cust',
  kind: 'service' as const,
  subtotalKobo: 1_000_000n,
  taxKobo: 75_000n,
  totalKobo: 1_075_000n,
};

const rentInvoice = {
  id: 'inv-rent',
  organizationId: 'org-tenant',
  kind: 'rent' as const,
  subtotalKobo: 2_400_000n,
  totalKobo: 2_400_000n,
  isRentOnBehalfOfOwner: true,
  ownerOrganizationId: 'org-owner',
  estateSegment: 'lekki-phase-1',
};

function accountsCredited(draft: JournalDraft): string[] {
  return draft.lines.filter((l) => l.creditKobo !== undefined).map((l) => l.accountCode);
}

function accountsDebited(draft: JournalDraft): string[] {
  return draft.lines.filter((l) => l.debitKobo !== undefined).map((l) => l.accountCode);
}

describe('every builder returns a balanced journal', () => {
  const drafts: Array<[string, JournalDraft]> = [
    [
      'invoiceIssued service',
      invoiceIssued({ invoice: serviceInvoice, recognitionPolicy: 'on_issue' }),
    ],
    ['invoiceIssued rent', invoiceIssued({ invoice: rentInvoice, recognitionPolicy: 'on_issue' })],
    [
      'revenueRecognized',
      revenueRecognized({
        invoice: { id: 'inv-2', organizationId: 'org-cust', kind: 'deposit' },
        amountKobo: 50_000n,
      }),
    ],
    [
      'gatewayPaymentSettled',
      gatewayPaymentSettled({
        attempt: {
          id: 'pa-1',
          invoiceId: 'inv-1',
          organizationId: 'org-cust',
          amountKobo: 1_075_000n,
          feesKobo: 16_125n,
        },
        allocatedKobo: 1_075_000n,
      }),
    ],
    [
      'gatewaySettlementToBank',
      gatewaySettlementToBank({
        settlement: { id: 'st-1', amountKobo: 5_000_000n, feesKobo: 1_000n },
      }),
    ],
    [
      'bankTransferConfirmed',
      bankTransferConfirmed({
        receipt: {
          id: 'rc-1',
          invoiceId: 'inv-1',
          organizationId: 'org-cust',
          confirmedAmountKobo: 500_000n,
          status: 'confirmed',
        },
        allocatedKobo: 500_000n,
      }),
    ],
    [
      'refundApproved',
      refundApproved({
        refund: {
          id: 'rf-1',
          invoiceId: 'inv-1',
          organizationId: 'org-cust',
          amountKobo: 100_000n,
          status: 'approved',
        },
        source: 'revenue',
      }),
    ],
    [
      'refundSettled',
      refundSettled({
        refund: { id: 'rf-1', organizationId: 'org-cust', amountKobo: 100_000n, status: 'pending' },
        providerStatus: 'processed',
      }),
    ],
    [
      'chargebackOpened',
      chargebackOpened({
        chargeback: { id: 'cb-1', paymentAttemptId: 'pa-1', amountKobo: 10_000n },
      }),
    ],
    [
      'chargebackLost',
      chargebackLost({ chargeback: { id: 'cb-1', paymentAttemptId: 'pa-1', amountKobo: 10_000n } }),
    ],
    [
      'chargebackWon',
      chargebackWon({ chargeback: { id: 'cb-1', paymentAttemptId: 'pa-1', amountKobo: 10_000n } }),
    ],
    [
      'creditNoteIssued',
      creditNoteIssued({
        creditNote: {
          id: 'cn-1',
          invoiceId: 'inv-1',
          organizationId: 'org-cust',
          amountKobo: 25_000n,
        },
        source: 'revenue',
      }),
    ],
    [
      'taxWithheld',
      taxWithheld({ invoice: { id: 'inv-1', organizationId: 'org-cust' }, withheldKobo: 50_000n }),
    ],
    [
      'taxRemitted',
      taxRemitted({ remittance: { id: 'tx-2026-09', amountKobo: 75_000n, period: '2026-09' } }),
    ],
    [
      'ownerDistributionApproved',
      ownerDistributionApproved({
        payout: {
          id: 'po-1',
          organizationId: 'org-owner',
          amountKobo: 2_000_000n,
          status: 'approved',
        },
        reconciliation: { id: 'rec-1', status: 'balanced' },
      }),
    ],
    [
      'ownerPayoutSettled',
      ownerPayoutSettled({
        payout: {
          id: 'po-1',
          organizationId: 'org-owner',
          amountKobo: 2_000_000n,
          status: 'submitted',
        },
        settlementReference: 'BANK-TRF-77',
      }),
    ],
    [
      'managementFeeFromCollectedRent',
      managementFeeFromCollectedRent({
        statement: { id: 'os-1', organizationId: 'org-owner' },
        collectedRentKobo: 2_400_000n,
        feeBps: 1000,
        taxBps: 750,
      }),
    ],
    [
      'maintenanceExpenseRecoverable',
      maintenanceExpenseRecoverable({
        workOrder: { id: 'wo-1', organizationId: 'org-owner', amountKobo: 80_000n },
      }),
    ],
    [
      'maintenanceExpenseRecovered',
      maintenanceExpenseRecovered({
        workOrder: { id: 'wo-1', organizationId: 'org-owner' },
        amountKobo: 80_000n,
      }),
    ],
    [
      'partnerFeeAccrued',
      partnerFeeAccrued({
        engagement: { id: 'sr-1', organizationId: 'org-cust' },
        amountKobo: 300_000n,
      }),
    ],
  ];

  it.each(drafts)('%s balances', (_name, draft) => {
    const totals = assertBalanced(draft);
    expect(totals.debitKobo).toBe(totals.creditKobo);
    expect(totals.lineCount).toBeGreaterThanOrEqual(2);
    expect(draft.currency).toBe('NGN');
  });

  it('gives every business event a unique reference derived from its source', () => {
    const refs = drafts.map(([, d]) => d.businessEventRef);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs).toContain('payment_attempt:pa-1:settled');
    expect(refs).toContain('invoice:inv-1:issued');
    expect(refs).toContain('refund:rf-1:approved');
    expect(refs).toContain('refund:rf-1:settled');
    expect(refs).toContain('chargeback:cb-1:won');
    for (const [, draft] of drafts) expect(draft.businessEventRef).toContain(draft.sourceId);
  });
});

describe('invoiceIssued', () => {
  it('books rent collected for an owner as a liability, never revenue', () => {
    const draft = invoiceIssued({ invoice: rentInvoice, recognitionPolicy: 'on_issue' });
    expect(accountsDebited(draft)).toEqual([ACCOUNTS.RENT_RECEIVABLE_ON_BEHALF_OF_OWNERS]);
    expect(accountsCredited(draft)).toEqual([ACCOUNTS.RENT_COLLECTED_PAYABLE_TO_OWNERS]);
    expect(draft.lines.some((l) => isRevenueAccount(l.accountCode))).toBe(false);
    expect(draft.estateSegment).toBe('lekki-phase-1');
    expect(draft.lines[1]!.organizationId).toBe('org-owner');
    expect(() =>
      invoiceIssued({
        invoice: { ...rentInvoice, kind: 'service' },
        recognitionPolicy: 'on_issue',
      }),
    ).toThrow(/only rent or service-charge/);
  });

  it('recognises service revenue on issue or defers it, with tax to 2300', () => {
    const now = invoiceIssued({ invoice: serviceInvoice, recognitionPolicy: 'on_issue' });
    expect(netForAccount(now, ACCOUNTS.CUSTOMER_RECEIVABLES)).toBe(1_075_000n);
    expect(netForAccount(now, ACCOUNTS.SERVICE_REVENUE)).toBe(-1_000_000n);
    expect(netForAccount(now, ACCOUNTS.TAX_AND_WITHHOLDING_PAYABLE)).toBe(-75_000n);

    const later = invoiceIssued({ invoice: serviceInvoice, recognitionPolicy: 'on_delivery' });
    expect(netForAccount(later, ACCOUNTS.CUSTOMER_DEPOSITS_AND_UNEARNED_REVENUE)).toBe(-1_000_000n);
    expect(netForAccount(later, ACCOUNTS.SERVICE_REVENUE)).toBe(0n);

    const deposit = invoiceIssued({
      invoice: {
        ...serviceInvoice,
        id: 'inv-dep',
        kind: 'deposit',
        taxKobo: 0n,
        totalKobo: 1_000_000n,
      },
      recognitionPolicy: 'on_issue',
    });
    expect(accountsCredited(deposit)).toEqual([ACCOUNTS.CUSTOMER_DEPOSITS_AND_UNEARNED_REVENUE]);
  });

  it('routes revenue by invoice kind and override', () => {
    expect(revenueAccountForInvoiceKind('management_fee')).toBe(ACCOUNTS.MANAGEMENT_FEE_REVENUE);
    expect(revenueAccountForInvoiceKind('tender_fee')).toBe(
      ACCOUNTS.TENDER_AND_PROCUREMENT_FEE_REVENUE,
    );
    expect(revenueAccountForInvoiceKind('procurement')).toBe(
      ACCOUNTS.TENDER_AND_PROCUREMENT_FEE_REVENUE,
    );
    expect(revenueAccountForInvoiceKind('installment')).toBe(ACCOUNTS.SERVICE_REVENUE);
    expect(revenueAccountForInvoiceKind('service', ACCOUNTS.REFERRAL_AND_PLACEMENT_REVENUE)).toBe(
      ACCOUNTS.REFERRAL_AND_PLACEMENT_REVENUE,
    );
    const referral = invoiceIssued({
      invoice: { ...serviceInvoice, id: 'inv-ref' },
      recognitionPolicy: 'on_issue',
      revenueAccount: ACCOUNTS.REFERRAL_AND_PLACEMENT_REVENUE,
    });
    expect(accountsCredited(referral)).toContain(ACCOUNTS.REFERRAL_AND_PLACEMENT_REVENUE);
  });

  it('validates amounts and the subtotal + tax = total identity', () => {
    expect(() =>
      invoiceIssued({
        invoice: { ...serviceInvoice, totalKobo: 1_000_000n },
        recognitionPolicy: 'on_issue',
      }),
    ).toThrow(/must equal subtotal/);
    expect(() =>
      invoiceIssued({
        invoice: { ...serviceInvoice, subtotalKobo: 0n, totalKobo: 75_000n },
        recognitionPolicy: 'on_issue',
      }),
    ).toThrow(/must be positive/);
    expect(() =>
      invoiceIssued({
        invoice: { ...serviceInvoice, currency: 'ngn' },
        recognitionPolicy: 'on_issue',
      }),
    ).toThrow(/three-letter/);
  });
});

describe('money in', () => {
  it('posts gateway settlements to clearing with fees and overpayments', () => {
    const draft = gatewayPaymentSettled({
      attempt: {
        id: 'pa-2',
        reference: 'sxd-2',
        invoiceId: 'inv-1',
        organizationId: 'org-cust',
        amountKobo: 1_100_000n,
        feesKobo: 16_500n,
      },
      allocatedKobo: 1_075_000n,
      overpaymentKobo: 25_000n,
    });
    expect(netForAccount(draft, ACCOUNTS.GATEWAY_CLEARING)).toBe(1_100_000n - 16_500n);
    expect(netForAccount(draft, ACCOUNTS.CUSTOMER_RECEIVABLES)).toBe(-1_075_000n);
    expect(netForAccount(draft, ACCOUNTS.CUSTOMER_DEPOSITS_AND_UNEARNED_REVENUE)).toBe(-25_000n);
    expect(netForAccount(draft, ACCOUNTS.GATEWAY_FEES)).toBe(16_500n);
    expect(draft.lines).toHaveLength(5);

    const noFees = gatewayPaymentSettled({
      attempt: {
        id: 'pa-3',
        invoiceId: 'inv-1',
        organizationId: 'org-cust',
        amountKobo: 10_000n,
        feesKobo: null,
      },
      allocatedKobo: 10_000n,
    });
    expect(noFees.lines).toHaveLength(2);
    expect(() =>
      gatewayPaymentSettled({
        attempt: {
          id: 'pa-4',
          invoiceId: 'inv-1',
          organizationId: 'org-cust',
          amountKobo: 10_000n,
        },
        allocatedKobo: 9_000n,
      }),
    ).toThrow(/must equal the attempt amount/);
    const rent = gatewayPaymentSettled({
      attempt: {
        id: 'pa-5',
        invoiceId: 'inv-rent',
        organizationId: 'org-tenant',
        amountKobo: 2_400_000n,
      },
      allocatedKobo: 2_400_000n,
      isRentOnBehalfOfOwner: true,
    });
    expect(accountsCredited(rent)).toEqual([ACCOUNTS.RENT_RECEIVABLE_ON_BEHALF_OF_OWNERS]);
  });

  it('posts confirmed bank transfers only', () => {
    for (const status of ['submitted', 'under_review', 'rejected'] as const) {
      expect(() =>
        bankTransferConfirmed({
          receipt: {
            id: 'rc-2',
            invoiceId: 'inv-1',
            organizationId: 'org-cust',
            confirmedAmountKobo: 1n,
            status,
          },
          allocatedKobo: 1n,
        }),
      ).toThrow(/not cleared money/);
    }
    const draft = bankTransferConfirmed({
      receipt: {
        id: 'rc-3',
        invoiceId: 'inv-1',
        organizationId: 'org-cust',
        confirmedAmountKobo: 1_075_000n,
        status: 'confirmed',
      },
      allocatedKobo: 1_075_000n,
    });
    expect(accountsDebited(draft)).toEqual([ACCOUNTS.BANK]);
    expect(accountsCredited(draft)).toEqual([ACCOUNTS.CUSTOMER_RECEIVABLES]);
  });

  it('moves gateway balances to bank', () => {
    const draft = gatewaySettlementToBank({ settlement: { id: 'st-2', amountKobo: 900_000n } });
    expect(netForAccount(draft, ACCOUNTS.BANK)).toBe(900_000n);
    expect(netForAccount(draft, ACCOUNTS.GATEWAY_CLEARING)).toBe(-900_000n);
  });
});

describe('refunds, chargebacks and credit notes', () => {
  it('settles refunds only after approval, submission and provider confirmation', () => {
    expect(() =>
      refundApproved({
        refund: {
          id: 'rf-2',
          invoiceId: 'inv-1',
          organizationId: 'org-cust',
          amountKobo: 1n,
          status: 'requested',
        },
        source: 'revenue',
      }),
    ).toThrow(/only approved refunds/);
    expect(() =>
      refundSettled({
        refund: { id: 'rf-2', organizationId: 'org-cust', amountKobo: 1n, status: 'requested' },
        providerStatus: 'processed',
      }),
    ).toThrow(/must be approved and submitted/);
    expect(() =>
      refundSettled({
        refund: { id: 'rf-2', organizationId: 'org-cust', amountKobo: 1n, status: 'approved' },
        providerStatus: 'processed',
      }),
    ).toThrow(/must be approved and submitted/);
    expect(() =>
      refundSettled({
        refund: { id: 'rf-2', organizationId: 'org-cust', amountKobo: 1n, status: 'submitted' },
        providerStatus: 'pending',
      }),
    ).toThrow(/only when the provider reports processed/);
    const settled = refundSettled({
      refund: { id: 'rf-2', organizationId: 'org-cust', amountKobo: 40_000n, status: 'submitted' },
      providerStatus: 'processed',
    });
    expect(netForAccount(settled, ACCOUNTS.REFUNDS_PAYABLE)).toBe(40_000n);
    expect(netForAccount(settled, ACCOUNTS.GATEWAY_CLEARING)).toBe(-40_000n);
  });

  it('reduces the right account when a refund or credit note is approved', () => {
    const fromRevenue = refundApproved({
      refund: {
        id: 'rf-3',
        invoiceId: 'inv-1',
        organizationId: 'org-cust',
        amountKobo: 1n,
        status: 'approved',
      },
      source: 'revenue',
      revenueAccount: ACCOUNTS.MANAGEMENT_FEE_REVENUE,
    });
    expect(accountsDebited(fromRevenue)).toEqual([ACCOUNTS.MANAGEMENT_FEE_REVENUE]);
    const fromUnearned = refundApproved({
      refund: {
        id: 'rf-4',
        invoiceId: 'inv-1',
        organizationId: 'org-cust',
        amountKobo: 1n,
        status: 'approved',
      },
      source: 'unearned',
    });
    expect(accountsDebited(fromUnearned)).toEqual([
      ACCOUNTS.CUSTOMER_DEPOSITS_AND_UNEARNED_REVENUE,
    ]);
    const rentCredit = creditNoteIssued({
      creditNote: {
        id: 'cn-2',
        invoiceId: 'inv-rent',
        organizationId: 'org-tenant',
        amountKobo: 5n,
      },
      source: 'rent_payable',
    });
    expect(accountsDebited(rentCredit)).toEqual([ACCOUNTS.RENT_COLLECTED_PAYABLE_TO_OWNERS]);
    expect(accountsCredited(rentCredit)).toEqual([ACCOUNTS.RENT_RECEIVABLE_ON_BEHALF_OF_OWNERS]);
  });

  it('keeps chargeback history: opened, lost, won mirror each other', () => {
    const input = { chargeback: { id: 'cb-2', paymentAttemptId: 'pa-1', amountKobo: 10_000n } };
    const opened = chargebackOpened(input);
    const lost = chargebackLost(input);
    const won = chargebackWon(input);
    expect(netForAccount(opened, ACCOUNTS.CHARGEBACKS_PENDING)).toBe(10_000n);
    expect(netForAccount(opened, ACCOUNTS.GATEWAY_CLEARING)).toBe(-10_000n);
    expect(netForAccount(lost, ACCOUNTS.REFUND_AND_CHARGEBACK_LOSSES)).toBe(10_000n);
    expect(netForAccount(lost, ACCOUNTS.CHARGEBACKS_PENDING)).toBe(-10_000n);
    expect(won.reversalOfBusinessEventRef).toBe('chargeback:cb-2:opened');
    expect(netForAccount(won, ACCOUNTS.CHARGEBACKS_PENDING)).toBe(
      -netForAccount(opened, ACCOUNTS.CHARGEBACKS_PENDING),
    );
    expect(netForAccount(won, ACCOUNTS.GATEWAY_CLEARING)).toBe(
      -netForAccount(opened, ACCOUNTS.GATEWAY_CLEARING),
    );
  });
});

describe('tax, owners and partners', () => {
  it('withholding reduces the receivable against tax payable', () => {
    const draft = taxWithheld({
      invoice: { id: 'inv-1', organizationId: 'org-cust' },
      withheldKobo: 50_000n,
      evidenceRef: 'WHT-CN-9',
    });
    expect(netForAccount(draft, ACCOUNTS.TAX_AND_WITHHOLDING_PAYABLE)).toBe(50_000n);
    expect(netForAccount(draft, ACCOUNTS.CUSTOMER_RECEIVABLES)).toBe(-50_000n);
    expect(draft.description).toContain('WHT-CN-9');
  });

  it('gates distributions behind dual approval and a balanced reconciliation', () => {
    const payout = { id: 'po-2', organizationId: 'org-owner', amountKobo: 1_000_000n };
    expect(() =>
      ownerDistributionApproved({
        payout: { ...payout, status: 'first_approved' },
        reconciliation: { id: 'rec-1', status: 'balanced' },
      }),
    ).toThrow(/both approvals/);
    expect(() =>
      ownerDistributionApproved({
        payout: { ...payout, status: 'approved' },
        reconciliation: { id: 'rec-1', status: 'open' },
      }),
    ).toThrow(/balanced reconciliation/);
    expect(() =>
      ownerDistributionApproved({
        payout: { ...payout, status: 'approved' },
        reconciliation: { id: 'rec-1', status: 'exceptions' },
      }),
    ).toThrow(/balanced reconciliation/);
    const approved = ownerDistributionApproved({
      payout: { ...payout, status: 'approved' },
      reconciliation: { id: 'rec-1', status: 'closed' },
    });
    expect(netForAccount(approved, ACCOUNTS.RENT_COLLECTED_PAYABLE_TO_OWNERS)).toBe(1_000_000n);
    expect(netForAccount(approved, ACCOUNTS.PARTNER_AND_SUPPLIER_PAYABLES)).toBe(-1_000_000n);
    expect(() =>
      ownerPayoutSettled({ payout: { ...payout, status: 'approved' }, settlementReference: 'x' }),
    ).toThrow(/submitted/);
    expect(() =>
      ownerPayoutSettled({ payout: { ...payout, status: 'submitted' }, settlementReference: ' ' }),
    ).toThrow(/settlement reference/);
    const settled = ownerPayoutSettled({
      payout: { ...payout, status: 'submitted' },
      settlementReference: 'STMT-1',
    });
    expect(netForAccount(settled, ACCOUNTS.BANK)).toBe(-1_000_000n);
  });

  it('computes management fees in basis points with bpsOf', () => {
    expect(computeManagementFee(2_400_000n, 1000)).toEqual({
      feeKobo: bpsOf(2_400_000n, 1000),
      taxKobo: 0n,
    });
    expect(computeManagementFee(2_400_000n, 1000, 750)).toEqual({
      feeKobo: 240_000n,
      taxKobo: 18_000n,
    });
    const draft = managementFeeFromCollectedRent({
      statement: {
        id: 'os-2',
        organizationId: 'org-owner',
        ownerOrganizationId: 'org-owner',
        period: '2026-09',
      },
      collectedRentKobo: 2_400_000n,
      feeBps: 1000,
      taxBps: 750,
    });
    expect(netForAccount(draft, ACCOUNTS.RENT_COLLECTED_PAYABLE_TO_OWNERS)).toBe(258_000n);
    expect(netForAccount(draft, ACCOUNTS.MANAGEMENT_FEE_REVENUE)).toBe(-240_000n);
    expect(netForAccount(draft, ACCOUNTS.TAX_AND_WITHHOLDING_PAYABLE)).toBe(-18_000n);
    expect(
      managementFeeFromCollectedRent({
        statement: { id: 'os-3', organizationId: 'o' },
        collectedRentKobo: 3n,
        feeBps: 3333,
      }).lines,
    ).toHaveLength(2);
    expect(() =>
      managementFeeFromCollectedRent({
        statement: { id: 'os-4', organizationId: 'o' },
        collectedRentKobo: 1n,
        feeBps: 100,
      }),
    ).toThrow(/rounds to zero/);
    expect(() =>
      managementFeeFromCollectedRent({
        statement: { id: 'os-5', organizationId: 'o' },
        collectedRentKobo: 100n,
        feeBps: -1,
      }),
    ).toThrow();
  });

  it('records recoverable maintenance and its recovery from the owner balance', () => {
    const expense = maintenanceExpenseRecoverable({
      workOrder: {
        id: 'wo-2',
        organizationId: 'org-owner',
        amountKobo: 80_000n,
        supplierOrganizationId: 'org-contractor',
      },
    });
    expect(netForAccount(expense, ACCOUNTS.MAINTENANCE_AND_ESTATE_EXPENSES_RECOVERABLE)).toBe(
      80_000n,
    );
    expect(expense.lines[1]!.organizationId).toBe('org-contractor');
    const recovered = maintenanceExpenseRecovered({
      workOrder: { id: 'wo-2', organizationId: 'org-owner' },
      amountKobo: 80_000n,
    });
    expect(netForAccount(recovered, ACCOUNTS.RENT_COLLECTED_PAYABLE_TO_OWNERS)).toBe(80_000n);
    expect(netForAccount(recovered, ACCOUNTS.MAINTENANCE_AND_ESTATE_EXPENSES_RECOVERABLE)).toBe(
      -80_000n,
    );
    expect(() =>
      maintenanceExpenseRecovered({
        workOrder: { id: 'wo-2', organizationId: 'org-owner' },
        amountKobo: 0n,
      }),
    ).toThrow(/positive/);
  });
});
