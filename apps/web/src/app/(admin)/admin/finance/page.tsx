import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { financeOverview } from '@/lib/admin/server/finance';
import { Section } from '@/components/admin/section';
import { StatTile } from '../_components/bits';

export const metadata: Metadata = { title: 'Finance' };
export const dynamic = 'force-dynamic';

export default async function FinanceOverviewPage() {
  const identity = await requireStaffPage('finance.read');
  const o = await financeOverview(identity);
  const inv = (s: string) => o.invoices[s] ?? 0;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Finance"
        description="Invoices, payment verification, bank-transfer review, refunds with separation of duties, credit notes, receipts, exports that reconcile to allocations, the chart of accounts and read-only journals. Money is integer kobo throughout."
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Draft invoices"
          value={inv('draft')}
          href="/admin/finance/invoices?status=draft"
        />
        <StatTile
          label="Issued, unpaid"
          value={inv('issued') + inv('partially_paid')}
          href="/admin/finance/invoices?status=issued"
        />
        <StatTile
          label="Overdue"
          value={inv('overdue')}
          href="/admin/finance/invoices?status=overdue"
          tone={inv('overdue') > 0 ? 'danger' : 'neutral'}
        />
        <StatTile
          label="Paid"
          value={inv('paid')}
          href="/admin/finance/invoices?status=paid"
          tone="success"
        />
        <StatTile
          label="Bank transfers to review"
          value={o.receiptsPendingReview}
          href="/admin/finance/bank-transfers"
          tone={o.receiptsPendingReview > 0 ? 'warning' : 'neutral'}
          hint="An uploaded receipt is not cleared money"
        />
        <StatTile
          label="Payments pending or uncertain"
          value={o.attemptsUncertain}
          href="/admin/finance/reconciliation"
          tone={o.attemptsUncertain > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Open reconciliation runs"
          value={o.openExceptions}
          href="/admin/finance/reconciliation"
          tone={o.openExceptions > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Refunds awaiting approval"
          value={o.refundsRequested}
          href="/admin/finance/refunds?status=requested"
          tone={o.refundsRequested > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Payouts awaiting approval"
          value={o.payoutsPending}
          href="/admin/finance/payouts"
          hint="Two different approvers required"
        />
        <StatTile label="Posted journals" value={o.journalCount} href="/admin/finance/journals" />
      </div>
      <Section
        title="What you can do here"
        description="Buttons appear only for your permissions; the server checks again on every action."
      >
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <Link href="/admin/finance/invoices" className="underline">
              Invoices
            </Link>
            :{' '}
            {o.permissions.manageInvoices
              ? 'create manual invoices, issue drafts, void unpaid invoices, issue credit notes'
              : 'read only'}
            .
          </li>
          <li>
            <Link href="/admin/finance/reconciliation" className="underline">
              Reconciliation
            </Link>
            :{' '}
            {o.permissions.reconcile
              ? 're-verify pending or uncertain gateway payments and review exceptions'
              : 'needs finance.reconcile'}
            .
          </li>
          <li>
            <Link href="/admin/finance/refunds" className="underline">
              Refunds
            </Link>
            :{' '}
            {o.permissions.requestRefunds
              ? 'request from a successful payment'
              : 'no request permission'}
            {o.permissions.approveRefunds
              ? '; approve or reject refunds someone else requested'
              : ''}
            .
          </li>
          <li>
            <Link href="/admin/finance/exports" className="underline">
              Exports
            </Link>
            :{' '}
            {o.permissions.exportAllowed
              ? 'allocation CSV with a reconciliation check against receipts'
              : 'needs finance.export'}
            .
          </li>
        </ul>
      </Section>
    </div>
  );
}
