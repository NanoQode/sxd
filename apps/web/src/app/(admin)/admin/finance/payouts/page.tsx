import type { Metadata } from 'next';
import Link from 'next/link';
import { payoutStatusSchema } from '@simplexd/contracts';
import { DataTable, PageHeader, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { can } from '@/lib/admin/server/context';
import { listPayouts } from '@/lib/admin/server/finance';
import { FilterBar, FilterSelect } from '@/components/admin/filter-bar';
import { Money } from '@/components/admin/money';
import { PayoutActions } from '@/components/admin/payout-actions';

export const metadata: Metadata = { title: 'Payouts' };
export const dynamic = 'force-dynamic';

function beneficiaryLabel(b: unknown): string {
  if (!b || typeof b !== 'object') return '—';
  const r = b as Record<string, unknown>;
  return (
    [r.accountName, r.bankName, r.accountNumberMasked].filter(Boolean).map(String).join(' · ') ||
    '—'
  );
}

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireStaffPage('finance.read');
  const raw = await searchParams;
  const status = payoutStatusSchema.safeParse(raw.status).success ? raw.status : undefined;
  const rows = await listPayouts(identity, 200, status);
  const me = identity.session!.user.id;
  const perms = {
    first: can(identity, 'finance.payouts.first_approve'),
    second: can(identity, 'finance.payouts.second_approve'),
    reconcile: can(identity, 'finance.reconcile'),
  };
  return (
    <div className="space-y-6">
      <PageHeader
        title="Payouts"
        description="Owner distributions are proposed from a reconciled owner statement (Rentals → Owner statements), never above its net payable. The proposer cannot give the first approval and the second approver must differ from the first; both need a verified authenticator. Settlement is recorded only with the bank's settlement reference."
        actions={
          <Link href="/admin/rentals/statements" className="text-sm underline">
            Owner statements
          </Link>
        }
      />
      <FilterBar>
        <FilterSelect
          name="status"
          label="Status"
          value={status}
          options={payoutStatusSchema.options.map((s) => ({ value: s, label: humanize(s) }))}
        />
      </FilterBar>
      <DataTable
        caption="Payouts"
        rows={rows}
        rowKey={(p) => p.id}
        rowLabel={(p) => `${p.organizationName} payout`}
        emptyMessage="No payouts in this view."
        columns={[
          {
            key: 'org',
            header: 'Owner',
            cell: (p) => (
              <span>
                {p.organizationName}
                <span className="block text-xs text-fg-muted">
                  {humanize(p.kind)} · {formatDateTimeLabel(p.createdAt)}
                </span>
              </span>
            ),
          },
          {
            key: 'amt',
            header: 'Amount',
            cell: (p) => <Money kobo={p.amountKobo} currency={p.currency} />,
          },
          {
            key: 'st',
            header: 'Status',
            cell: (p) => (
              <StatusBadge
                status={
                  p.status === 'settled'
                    ? 'successful'
                    : p.status === 'proposed'
                      ? 'pending'
                      : p.status
                }
                label={humanize(p.status)}
              />
            ),
          },
          {
            key: 'ben',
            header: 'Beneficiary',
            cell: (p) => beneficiaryLabel(p.beneficiary),
            hideOnMobile: true,
          },
          {
            key: 'who',
            header: 'Proposed · 1st · 2nd',
            cell: (p) =>
              `${p.proposedByName ?? '—'} · ${p.firstApproverName ?? '—'} · ${p.secondApproverName ?? '—'}`,
            hideOnMobile: true,
          },
          {
            key: 'act',
            header: 'Next step',
            cell: (p) => (
              <span className="flex flex-wrap items-center gap-1">
                <PayoutActions payout={p} me={me} perms={perms} />
                <Link href={`/admin/rentals/payouts/${p.id}`} className="text-sm underline">
                  Details
                </Link>
                {p.failureReason ? (
                  <span className="text-xs text-fg-muted">{p.failureReason}</span>
                ) : null}
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
