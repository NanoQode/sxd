import type { Metadata } from 'next';
import Link from 'next/link';
import {
  DataTable,
  EmptyState,
  PageHeader,
  StatusBadge,
  formatDateLabel,
  formatNairaString,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { listInvoices } from '@/server/portal/lists';

export const metadata: Metadata = { title: 'Invoices' };
export const dynamic = 'force-dynamic';

export default async function InvoicesPage() {
  const identity = await requireSignedIn('/portal/invoices');
  const invoices = await listInvoices(identity);
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const outstanding = invoices.filter((i) =>
    ['issued', 'partially_paid', 'overdue'].includes(i.status),
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title="Invoices"
        description="Invoices are issued after you accept a quotation or a milestone is authorised. Payment status reflects verified provider confirmations, never a browser redirect alone."
      />
      {invoices.length === 0 ? (
        <EmptyState
          title="No invoices"
          description="Nothing has been invoiced to your organisation. Deposits and instalments appear here once an accepted quotation is invoiced; you can then pay by card, bank or transfer through Paystack, or declare a bank transfer for finance to confirm."
        />
      ) : (
        <>
          {outstanding.length > 0 ? (
            <p role="status" className="text-sm text-fg-muted">
              {outstanding.length} invoice{outstanding.length === 1 ? '' : 's'} outstanding. Open an
              invoice to pay it or declare a transfer.
            </p>
          ) : null}
          <DataTable
            caption="Invoices"
            rows={invoices}
            rowKey={(i) => i.id}
            rowLabel={(i) => `Invoice ${i.number}`}
            columns={[
              {
                key: 'number',
                header: 'Number',
                cell: (i) => (
                  <Link
                    href={`/portal/invoices/${i.id}`}
                    className="font-mono text-primary underline"
                  >
                    {i.number}
                  </Link>
                ),
              },
              { key: 'kind', header: 'Kind', cell: (i) => humanize(i.kind) },
              { key: 'status', header: 'Status', cell: (i) => <StatusBadge status={i.status} /> },
              {
                key: 'total',
                header: 'Total',
                cell: (i) => formatNairaString(i.totalKobo),
                className: 'text-right',
              },
              {
                key: 'outstanding',
                header: 'Balance',
                cell: (i) => formatNairaString(i.outstandingKobo),
                className: 'text-right',
              },
              {
                key: 'due',
                header: 'Due',
                cell: (i) => (i.dueDate ? formatDateLabel(i.dueDate, zone) : '—'),
              },
              {
                key: 'issued',
                header: 'Issued',
                cell: (i) => (i.issuedAt ? formatDateLabel(i.issuedAt, zone) : '—'),
                hideOnMobile: true,
              },
            ]}
          />
        </>
      )}
    </div>
  );
}
