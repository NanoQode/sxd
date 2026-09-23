import type { Metadata } from 'next';
import Link from 'next/link';
import { DataTable, PageHeader, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { listCreditNotes, listReceipts } from '@/lib/admin/server/finance';
import { ExportCsvButton } from '@/components/admin/export-csv-button';
import { Money } from '@/components/admin/money';
import { Section } from '@/components/admin/section';
import { Mono } from '../../_components/bits';

export const metadata: Metadata = { title: 'Credit notes and receipts' };
export const dynamic = 'force-dynamic';

export default async function FinanceDocumentsPage() {
  const identity = await requireStaffPage('finance.read');
  const [credits, receipts] = await Promise.all([listCreditNotes(identity, 200), listReceipts(identity, 200)]);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Credit notes and receipts"
        description="Numbered, immutable documents. Credit notes are issued from an invoice page; receipts are issued automatically for every allocation (gateway, confirmed bank transfer or credit note). The 200 most recent of each are listed."
      />
      <Section
        title={`Receipts (${receipts.length})`}
        actions={
          <ExportCsvButton
            rows={receipts}
            filename="receipts.csv"
            columns={[
              { header: 'Receipt', value: (r) => r.number },
              { header: 'Invoice', value: (r) => r.invoiceNumber },
              { header: 'Organisation', value: (r) => r.organizationName },
              { header: 'Source', value: (r) => r.source },
              { header: 'Amount kobo', value: (r) => r.amountKobo },
              { header: 'Currency', value: (r) => r.currency },
              { header: 'Issued at', value: (r) => r.issuedAt },
              { header: 'Allocation id', value: (r) => r.allocationId },
            ]}
          />
        }
      >
        <DataTable
          caption="Receipts"
          rows={receipts}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.number}
          emptyMessage="No receipts yet."
          columns={[
            { key: 'n', header: 'Receipt', cell: (r) => <Mono>{r.number}</Mono> },
            { key: 'inv', header: 'Invoice', cell: (r) => <Link href={`/admin/finance/invoices/${r.invoiceId}`} className="underline">{r.invoiceNumber || 'invoice'}</Link> },
            { key: 'org', header: 'Organisation', cell: (r) => r.organizationName, hideOnMobile: true },
            { key: 'src', header: 'Source', cell: (r) => humanize(r.source) },
            { key: 'amt', header: 'Amount', cell: (r) => <Money kobo={r.amountKobo} currency={r.currency} /> },
            { key: 'at', header: 'Issued', cell: (r) => formatDateTimeLabel(r.issuedAt), hideOnMobile: true },
          ]}
        />
      </Section>
      <Section title={`Credit notes (${credits.length})`}>
        <DataTable
          caption="Credit notes"
          rows={credits}
          rowKey={(c) => c.id}
          rowLabel={(c) => c.number}
          emptyMessage="No credit notes."
          columns={[
            { key: 'n', header: 'Credit note', cell: (c) => <Mono>{c.number}</Mono> },
            { key: 'inv', header: 'Invoice', cell: (c) => <Link href={`/admin/finance/invoices/${c.invoiceId}`} className="underline">{c.invoiceNumber ?? 'invoice'}</Link> },
            { key: 'org', header: 'Organisation', cell: (c) => c.organizationName, hideOnMobile: true },
            { key: 'amt', header: 'Amount', cell: (c) => <Money kobo={c.amountKobo} currency={c.currency} /> },
            { key: 'st', header: 'Status', cell: (c) => humanize(c.status) },
            { key: 'reason', header: 'Reason', cell: (c) => c.reason, hideOnMobile: true },
            { key: 'at', header: 'Issued', cell: (c) => (c.issuedAt ? formatDateTimeLabel(c.issuedAt) : '—'), hideOnMobile: true },
          ]}
        />
      </Section>
    </div>
  );
}
