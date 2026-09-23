import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { ToastProvider } from '@simplexd/ui';
import type { InvoiceListRow } from '@/lib/admin/server/finance';
import { InvoicesTable } from '@/app/(admin)/admin/finance/invoices/_components/invoices-table';
import { BankReceiptActions } from '@/app/(admin)/admin/finance/_components/bank-receipt-actions';
import { ExportCsvButton } from './export-csv-button';
import { LoadError } from './load-error';
import { Money } from './money';
import { PayoutActions } from './payout-actions';

// The shared confirmation dialog lives with the admin shell; its behaviour is covered there.
vi.mock('@/app/(admin)/admin/_components/action-dialog', () => ({ ActionDialog: () => null }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined, replace: () => undefined }),
  usePathname: () => '/admin/finance',
  useSearchParams: () => new URLSearchParams(),
}));

/** SSR inserts comment markers between adjacent text nodes; strip them for substring assertions. */
const render = (element: ReactElement): string =>
  renderRaw(createElement(ToastProvider, null, element)).replace(/<!-- -->/g, '');

function invoice(patch: Partial<InvoiceListRow>): InvoiceListRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    number: 'INV-2026-0001',
    organizationId: 'org_a',
    organizationName: 'Adeyemi Family Holdings',
    kind: 'service',
    status: 'draft',
    serviceRequestId: null,
    serviceRequestReference: null,
    quoteVersionId: null,
    customerUserId: null,
    currency: 'NGN',
    subtotalKobo: '100000',
    taxKobo: '7500',
    withholdingKobo: '0',
    totalKobo: '107500',
    amountPaidKobo: '0',
    amountCreditedKobo: '0',
    balanceKobo: '107500',
    taxTreatmentKey: null,
    dueDate: '2026-10-01',
    issuedAt: null,
    paidAt: null,
    voidedAt: null,
    voidReason: null,
    notes: null,
    installmentPlan: null,
    lines: [],
    version: 1,
    createdAt: '2026-09-23T10:00:00.000Z',
    updatedAt: '2026-09-23T10:00:00.000Z',
    ...patch,
  };
}

describe('LoadError', () => {
  it('turns an MFA refusal into a link to authenticator enrolment instead of a crash', () => {
    const html = render(
      createElement(LoadError, { code: 'mfa_required', message: 'x', what: 'Reconciliation' }),
    );
    expect(html).toContain('Reconciliation needs a verified authenticator');
    expect(html).toContain('href="/admin/security/mfa"');
  });
  it('explains a disabled feature flag honestly', () => {
    const html = render(
      createElement(LoadError, { code: 'feature_disabled', message: 'x', what: 'Tenders' }),
    );
    expect(html).toContain('Tenders is switched off');
    expect(html).toContain('Records created while it was on are retained');
  });
});

describe('Money', () => {
  it('formats integer kobo and never invents a figure for unknown values', () => {
    expect(render(createElement(Money, { kobo: '123456' }))).toContain('₦1,234.56');
    expect(render(createElement(Money, { kobo: null }))).toContain('unknown');
    expect(render(createElement(Money, { kobo: '12.5' }))).toContain('unknown');
  });
});

describe('ExportCsvButton', () => {
  it('builds the CSV where it renders and disables itself when there is nothing to export', () => {
    const cols = [{ header: 'Number', value: (r: { n: string }) => r.n }];
    expect(
      render(
        createElement(ExportCsvButton<{ n: string }>, {
          rows: [],
          columns: cols,
          filename: 'x.csv',
        }),
      ),
    ).toContain('disabled');
    const html = render(
      createElement(ExportCsvButton<{ n: string }>, {
        rows: [{ n: 'A' }, { n: 'B' }],
        columns: cols,
        filename: 'x.csv',
      }),
    );
    expect(html).toContain('Export 2 rows');
    expect(html).not.toContain('disabled=""');
  });
});

describe('PayoutActions (two approvers)', () => {
  const perms = { first: true, second: true, reconcile: true };
  it('stops the proposer from giving the first approval', () => {
    const html = render(
      createElement(PayoutActions, {
        payout: { id: 'p1', status: 'proposed', proposedBy: 'me', firstApproverId: null },
        me: 'me',
        perms,
      }),
    );
    expect(html).toContain('First approval');
    expect(html).toContain('someone else gives the first approval');
    expect(html).toMatch(/<button[^>]*disabled/);
  });
  it('stops the first approver from giving the second approval but lets another person', () => {
    const blocked = render(
      createElement(PayoutActions, {
        payout: { id: 'p1', status: 'first_approved', proposedBy: 'a', firstApproverId: 'me' },
        me: 'me',
        perms,
      }),
    );
    expect(blocked).toContain('a different approver must give the second');
    const allowed = render(
      createElement(PayoutActions, {
        payout: { id: 'p1', status: 'first_approved', proposedBy: 'a', firstApproverId: 'b' },
        me: 'me',
        perms,
      }),
    );
    expect(allowed).toContain('Second approval');
    expect(allowed).not.toContain('a different approver must give the second');
  });
  it('offers submit, settlement and failure only to finance reconcilers at the right step', () => {
    expect(
      render(
        createElement(PayoutActions, {
          payout: { id: 'p', status: 'approved', proposedBy: 'a', firstApproverId: 'b' },
          me: 'c',
          perms,
        }),
      ),
    ).toContain('Mark submitted to bank');
    const submitted = render(
      createElement(PayoutActions, {
        payout: { id: 'p', status: 'submitted', proposedBy: 'a', firstApproverId: 'b' },
        me: 'c',
        perms,
      }),
    );
    expect(submitted).toContain('Record settlement');
    expect(submitted).toContain('Mark failed');
    expect(
      render(
        createElement(PayoutActions, {
          payout: { id: 'p', status: 'submitted', proposedBy: 'a', firstApproverId: 'b' },
          me: 'c',
          perms: { ...perms, reconcile: false },
        }),
      ),
    ).not.toContain('Record settlement');
  });
});

describe('InvoicesTable', () => {
  it('shows selection and bulk issue only to invoice managers, with money in naira', () => {
    const rows = [
      invoice({}),
      invoice({
        id: '00000000-0000-4000-8000-000000000002',
        number: 'INV-2026-0002',
        status: 'paid',
        balanceKobo: '0',
      }),
    ];
    const managed = render(createElement(InvoicesTable, { rows, canManage: true }));
    expect(managed).toContain('Select INV-2026-0001');
    expect(managed).toContain('₦1,075');
    expect(managed).toContain(
      'href="/admin/finance/invoices/00000000-0000-4000-8000-000000000002"',
    );
    const readOnly = render(createElement(InvoicesTable, { rows, canManage: false }));
    expect(readOnly).not.toContain('Select INV-2026-0001');
    expect(readOnly).toContain('Export CSV');
  });
});

describe('BankReceiptActions', () => {
  it('explains the missing permission instead of showing dead buttons', () => {
    const html = render(
      createElement(BankReceiptActions, {
        receiptId: 'r',
        declaredAmountKobo: '5000000',
        invoiceBalanceKobo: '5000000',
        invoiceNumber: 'INV-1',
        canReconcile: false,
      }),
    );
    expect(html).toContain('Review needs finance.reconcile');
    expect(html).not.toContain('>Confirm<');
  });
  it('offers confirm and reject to reconcilers', () => {
    const html = render(
      createElement(BankReceiptActions, {
        receiptId: 'r',
        declaredAmountKobo: '5000000',
        invoiceBalanceKobo: '5000000',
        invoiceNumber: 'INV-1',
        canReconcile: true,
      }),
    );
    expect(html).toContain('Confirm');
    expect(html).toContain('Reject');
  });
});
