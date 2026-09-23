import type { Metadata } from 'next';
import Link from 'next/link';
import { partnerInvoiceStatusSchema } from '@simplexd/contracts';
import { DataTable, PageHeader, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { attempt, can } from '@/lib/admin/server/context';
import { listPartnerInvoices } from '@/server/finance/partner-invoices';
import { FilterBar, FilterSelect } from '@/components/admin/filter-bar';
import { LoadError } from '@/components/admin/load-error';
import { Money } from '@/components/admin/money';
import { PartnerInvoiceActions } from './_components/partner-invoice-actions';

export const metadata: Metadata = { title: 'Partner invoices' };
export const dynamic = 'force-dynamic';

const SOURCE_LINK: Record<string, (id: string) => string> = {
  purchase_order: (id) => `/admin/procurement/purchase-orders/${id}`,
  assignment: () => '/admin/operations',
};

export default async function PartnerInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireStaffPage('finance.read');
  const raw = await searchParams;
  const status = partnerInvoiceStatusSchema.safeParse(raw.status).success
    ? (raw.status as (typeof partnerInvoiceStatusSchema.options)[number])
    : undefined;
  const loaded = await attempt(() => listPartnerInvoices(identity, { status, limit: 100 }));
  if (!loaded.ok)
    return <LoadError code={loaded.code} message={loaded.message} what="Partner invoices" />;
  const me = identity.session!.user.id;
  const perms = {
    first: can(identity, 'finance.payouts.first_approve'),
    second: can(identity, 'finance.payouts.second_approve'),
    reconcile: can(identity, 'finance.reconcile'),
  };
  return (
    <div className="space-y-6">
      <PageHeader
        title="Partner invoices"
        description="Invoices partners submit against purchase orders issued to them or assignments marked completed. Accepting is the first approval and posts the payable; a different approver authorises payment; finance submits the transfer and records settlement with the bank reference. Nothing is paid without both approvals."
      />
      <FilterBar>
        <FilterSelect
          name="status"
          label="Status"
          value={status}
          options={partnerInvoiceStatusSchema.options.map((s) => ({
            value: s,
            label: humanize(s),
          }))}
        />
      </FilterBar>
      <DataTable
        caption="Partner invoices"
        rows={loaded.value.items}
        rowKey={(i) => i.id}
        rowLabel={(i) => `${i.partnerName ?? i.partnerUserId} ${i.reference}`}
        emptyMessage="No partner invoices in this view."
        columns={[
          {
            key: 'partner',
            header: 'Partner · reference',
            cell: (i) => (
              <span>
                <span className="font-medium">{i.partnerName ?? i.partnerUserId}</span>
                <span className="block text-xs text-fg-muted">
                  {i.reference} · submitted {formatDateTimeLabel(i.submittedAt)}
                </span>
              </span>
            ),
          },
          {
            key: 'source',
            header: 'For',
            cell: (i) => (
              <span>
                <Link href={SOURCE_LINK[i.source.type]?.(i.source.id) ?? '#'} className="underline">
                  {i.source.label}
                </Link>
                <span className="block text-xs text-fg-muted">
                  {i.organizationName ?? i.organizationId}
                </span>
              </span>
            ),
            hideOnMobile: true,
          },
          {
            key: 'amount',
            header: 'Amount',
            cell: (i) => <Money kobo={i.amountKobo} currency={i.currency} />,
          },
          {
            key: 'status',
            header: 'Status',
            cell: (i) => (
              <span>
                <StatusBadge
                  status={
                    i.status === 'settled'
                      ? 'successful'
                      : i.status === 'proposed'
                        ? 'pending'
                        : i.status
                  }
                  label={humanize(i.status)}
                />
                {i.failureReason ? (
                  <span className="block text-xs text-fg-muted">{i.failureReason}</span>
                ) : null}
              </span>
            ),
          },
          {
            key: 'who',
            header: 'Accepted · 2nd',
            cell: (i) =>
              `${i.review?.decision === 'accepted' ? (i.review.byName ?? '—') : '—'} · ${
                i.history.find((h) => h.action === 'second_approved')?.byName ?? '—'
              }`,
            hideOnMobile: true,
          },
          {
            key: 'act',
            header: 'Next step',
            cell: (i) => (
              <span className="flex flex-wrap items-center gap-1">
                <PartnerInvoiceActions invoice={i} me={me} perms={perms} />
                {i.attachmentFileId ? (
                  <Link
                    href={`/api/v1/files/${i.attachmentFileId}/download?disposition=inline`}
                    className="text-sm underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Document
                  </Link>
                ) : null}
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
