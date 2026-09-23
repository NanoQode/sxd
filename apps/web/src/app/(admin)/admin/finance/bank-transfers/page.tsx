import type { Metadata } from 'next';
import Link from 'next/link';
import { bankReceiptStatusSchema } from '@simplexd/contracts';
import { DataTable, PageHeader, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { can } from '@/lib/admin/server/context';
import { listBankReceipts } from '@/lib/admin/server/finance';
import { FilterBar, FilterSelect } from '@/components/admin/filter-bar';
import { Money } from '@/components/admin/money';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';
import { BankReceiptActions } from '../_components/bank-receipt-actions';

export const metadata: Metadata = { title: 'Bank transfers' };
export const dynamic = 'force-dynamic';

export default async function BankTransfersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireStaffPage('finance.read');
  const raw = await searchParams;
  const status = bankReceiptStatusSchema.safeParse(raw.status).success ? raw.status : undefined;
  const rows = await listBankReceipts(identity, { status, limit: 200 });
  const canReconcile = can(identity, 'finance.reconcile');
  return (
    <div className="space-y-6">
      <PageHeader
        title="Bank transfers"
        description="Customers declare transfers with a reference and, optionally, the bank slip. Oldest first. Confirm only after the money is on the bank statement; confirmation allocates it and issues a receipt."
      />
      <SavedViewsBar tableKey="finance-bank-transfers" />
      <FilterBar>
        <FilterSelect
          name="status"
          label="Status"
          value={status}
          allLabel="Awaiting review"
          options={bankReceiptStatusSchema.options.map((s) => ({ value: s, label: humanize(s) }))}
        />
      </FilterBar>
      <DataTable
        caption="Declared bank transfers"
        rows={rows}
        rowKey={(r) => r.id}
        rowLabel={(r) => `${r.invoiceNumber ?? ''} ${r.bankReference ?? ''}`}
        emptyMessage="No declarations in this view."
        columns={[
          {
            key: 'inv',
            header: 'Invoice',
            cell: (r) => (
              <Link
                href={`/admin/finance/invoices/${r.invoiceId}`}
                className="font-medium underline"
              >
                {r.invoiceNumber ?? 'invoice'}
              </Link>
            ),
          },
          { key: 'org', header: 'Organisation', cell: (r) => r.organizationName },
          { key: 'amt', header: 'Declared', cell: (r) => <Money kobo={r.declaredAmountKobo} /> },
          {
            key: 'bal',
            header: 'Invoice balance',
            cell: (r) => <Money kobo={r.invoiceBalanceKobo} />,
            hideOnMobile: true,
          },
          {
            key: 'ref',
            header: 'Bank ref / paid on',
            cell: (r) => `${r.bankReference ?? '—'} · ${r.declaredPaidAt ?? '—'}`,
            hideOnMobile: true,
          },
          {
            key: 'file',
            header: 'Slip',
            cell: (r) =>
              r.uploadedFileId ? (
                <a href={`/api/v1/files/${r.uploadedFileId}/download`} className="underline">
                  download
                </a>
              ) : (
                'none'
              ),
            hideOnMobile: true,
          },
          {
            key: 'by',
            header: 'Declared',
            cell: (r) => `${r.submittedByName ?? '—'} · ${formatDateTimeLabel(r.createdAt)}`,
            hideOnMobile: true,
          },
          {
            key: 'st',
            header: 'Status',
            cell: (r) => (
              <StatusBadge
                status={
                  r.status === 'confirmed'
                    ? 'successful'
                    : r.status === 'rejected'
                      ? 'rejected'
                      : 'pending'
                }
                label={humanize(r.status)}
              />
            ),
          },
          {
            key: 'act',
            header: 'Review',
            cell: (r) =>
              ['submitted', 'under_review'].includes(r.status) ? (
                <BankReceiptActions
                  receiptId={r.id}
                  declaredAmountKobo={r.declaredAmountKobo}
                  invoiceBalanceKobo={r.invoiceBalanceKobo}
                  invoiceNumber={r.invoiceNumber}
                  canReconcile={canReconcile}
                />
              ) : (
                <span className="text-xs text-fg-muted">{r.reviewNote ?? '—'}</span>
              ),
          },
        ]}
      />
    </div>
  );
}
