import type { Metadata } from 'next';
import Link from 'next/link';
import { payoutStatusSchema } from '@simplexd/contracts';
import { DataTable, PageHeader, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt, can } from '@/lib/admin/server/context';
import { listPayouts } from '@/lib/admin/server/finance';
import { FilterBar, FilterSelect } from '@/components/admin/filter-bar';
import { LoadError } from '@/components/admin/load-error';
import { Money } from '@/components/admin/money';
import { PayoutActions } from '@/components/admin/payout-actions';

export const metadata: Metadata = { title: 'Owner payouts' };
export const dynamic = 'force-dynamic';

export default async function RentalPayoutsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireSignedIn('/admin/rentals/payouts');
  const raw = await searchParams;
  const status = payoutStatusSchema.safeParse(raw.status).success ? raw.status : undefined;
  const loaded = await attempt(() => listPayouts(identity, 200, status));
  if (!loaded.ok) return <LoadError code={loaded.code} message={loaded.message} what="Payouts" />;
  const me = identity.session!.user.id;
  const perms = {
    first: can(identity, 'finance.payouts.first_approve'),
    second: can(identity, 'finance.payouts.second_approve'),
    reconcile: can(identity, 'finance.reconcile'),
  };
  return (
    <div className="space-y-6">
      <PageHeader
        title="Owner payouts"
        description="Proposed from a reconciled owner statement; first approval (not the proposer), second approval by a different approver, then finance submits and records settlement against the bank reference."
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
        caption="Owner payouts"
        rows={loaded.value}
        rowKey={(p) => p.id}
        rowLabel={(p) => p.organizationName}
        emptyMessage="No payouts in this view. Propose one from a reconciled owner statement."
        columns={[
          {
            key: 'o',
            header: 'Owner',
            cell: (p) => (
              <Link
                href={`/admin/rentals/payouts/${p.id}`}
                className="font-medium text-primary underline"
              >
                {p.organizationName}
              </Link>
            ),
          },
          {
            key: 'a',
            header: 'Amount',
            cell: (p) => <Money kobo={p.amountKobo} currency={p.currency} />,
          },
          {
            key: 's',
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
            key: 'w',
            header: 'Proposed',
            cell: (p) => `${p.proposedByName ?? '—'} · ${formatDateTimeLabel(p.createdAt)}`,
            hideOnMobile: true,
          },
          {
            key: 'n',
            header: 'Next step',
            cell: (p) => <PayoutActions payout={p} me={me} perms={perms} />,
          },
        ]}
      />
    </div>
  );
}
