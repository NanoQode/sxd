import type { Metadata } from 'next';
import Link from 'next/link';
import { refundStatusSchema } from '@simplexd/contracts';
import {
  Alert,
  DataTable,
  PageHeader,
  StatusBadge,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { can } from '@/lib/admin/server/context';
import { listRefunds } from '@/lib/admin/server/finance';
import { ApiAction } from '@/components/admin/api-action';
import { ExportCsvButton } from '@/components/admin/export-csv-button';
import { FilterBar, FilterSelect } from '@/components/admin/filter-bar';
import { Money } from '@/components/admin/money';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';

export const metadata: Metadata = { title: 'Refunds' };
export const dynamic = 'force-dynamic';

export default async function RefundsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireStaffPage('finance.read');
  const raw = await searchParams;
  const status = refundStatusSchema.safeParse(raw.status).success ? raw.status : undefined;
  const rows = await listRefunds(identity, { status, limit: 200 });
  const me = identity.session!.user.id;
  const canApprove = can(identity, 'finance.refunds.approve');
  return (
    <div className="space-y-6">
      <PageHeader
        title="Refunds"
        description="Refunds are separate records requested from a successful payment (on the invoice page). Approval must come from a different person than the requester and needs a verified authenticator. A refund is settled only when the provider confirms it; a successful submission alone is not settlement."
      />
      {canApprove && !identity.actor.mfaVerified ? (
        <Alert tone="warning" title="Refund approval needs your authenticator">
          <Link href="/admin/security/mfa" className="underline">
            Verify multi-factor authentication
          </Link>{' '}
          before approving; the server refuses otherwise.
        </Alert>
      ) : null}
      <SavedViewsBar tableKey="finance-refunds" />
      <FilterBar>
        <FilterSelect
          name="status"
          label="Status"
          value={status}
          options={refundStatusSchema.options.map((s) => ({ value: s, label: humanize(s) }))}
        />
      </FilterBar>
      <div className="flex justify-end">
        <ExportCsvButton
          rows={rows}
          filename="refunds.csv"
          columns={[
            { header: 'Refund id', value: (r) => r.id },
            { header: 'Invoice', value: (r) => r.invoiceNumber },
            { header: 'Organisation', value: (r) => r.organizationName },
            { header: 'Amount kobo', value: (r) => r.amountKobo },
            { header: 'Currency', value: (r) => r.currency },
            { header: 'Status', value: (r) => r.status },
            { header: 'Requested by', value: (r) => r.requestedByName },
            { header: 'Approved by', value: (r) => r.approvedByName },
            { header: 'Settled at', value: (r) => r.settledAt },
          ]}
        />
      </div>
      <DataTable
        caption="Refunds"
        rows={rows}
        rowKey={(r) => r.id}
        rowLabel={(r) => `${r.invoiceNumber ?? ''} refund`}
        emptyMessage="No refunds in this view."
        columns={[
          {
            key: 'inv',
            header: 'Invoice',
            cell: (r) => (
              <Link href={`/admin/finance/invoices/${r.invoiceId}`} className="underline">
                {r.invoiceNumber ?? 'invoice'}
              </Link>
            ),
          },
          {
            key: 'org',
            header: 'Organisation',
            cell: (r) => r.organizationName,
            hideOnMobile: true,
          },
          {
            key: 'amt',
            header: 'Amount',
            cell: (r) => <Money kobo={r.amountKobo} currency={r.currency} />,
          },
          {
            key: 'st',
            header: 'Status',
            cell: (r) => (
              <StatusBadge
                status={r.status === 'settled' ? 'successful' : r.status}
                label={humanize(r.status)}
              />
            ),
          },
          { key: 'reason', header: 'Reason', cell: (r) => r.reason },
          {
            key: 'who',
            header: 'Requested → approved',
            cell: (r) => `${r.requestedByName ?? '—'} → ${r.approvedByName ?? '—'}`,
            hideOnMobile: true,
          },
          {
            key: 'when',
            header: 'Requested',
            cell: (r) => formatDateTimeLabel(r.createdAt),
            hideOnMobile: true,
          },
          {
            key: 'act',
            header: 'Decision',
            cell: (r) =>
              r.status === 'requested' && canApprove ? (
                <span className="flex flex-wrap gap-1">
                  <ApiAction
                    path={`/api/v1/refunds/${r.id}/approve`}
                    reasonKey="reason"
                    label="Approve"
                    variant="primary"
                    disabled={r.requestedBy === me}
                    disabledReason="You requested this refund; separation of duties requires another approver."
                    confirm={{
                      title: 'Approve this refund?',
                      description:
                        'Posts the refund liability and queues provider submission. Settlement waits for the provider.',
                      confirmLabel: 'Approve refund',
                    }}
                    successMessage="Refund approved"
                  />
                  <ApiAction
                    path={`/api/v1/refunds/${r.id}/reject`}
                    reasonKey="reason"
                    label="Reject"
                    variant="ghost"
                    confirm={{
                      title: 'Reject this refund?',
                      requireReason: true,
                      confirmLabel: 'Reject',
                      tone: 'danger',
                    }}
                    successMessage="Refund rejected"
                  />
                </span>
              ) : (
                <span className="text-xs text-fg-muted">
                  {r.failureReason ??
                    (r.status === 'requested' ? 'Needs finance.refunds.approve' : '')}
                </span>
              ),
          },
        ]}
      />
    </div>
  );
}
