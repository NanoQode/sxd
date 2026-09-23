import type { Metadata } from 'next';
import Link from 'next/link';
import { payoutStatusSchema } from '@simplexd/contracts';
import { DataTable, PageHeader, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { can } from '@/lib/admin/server/context';
import { listPayouts } from '@/lib/admin/server/finance';
import { ApiAction } from '@/components/admin/api-action';
import { FilterBar, FilterSelect } from '@/components/admin/filter-bar';
import { FormDialog } from '@/components/admin/form-dialog';
import { Money } from '@/components/admin/money';

export const metadata: Metadata = { title: 'Payouts' };
export const dynamic = 'force-dynamic';

function beneficiaryLabel(b: unknown): string {
  if (!b || typeof b !== 'object') return '—';
  const r = b as Record<string, unknown>;
  return [r.accountName, r.bankName, r.accountNumberMasked].filter(Boolean).map(String).join(' · ') || '—';
}

export default async function PayoutsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
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
          <Link href="/admin/rentals?tab=statements" className="text-sm underline">
            Owner statements
          </Link>
        }
      />
      <FilterBar>
        <FilterSelect name="status" label="Status" value={status} options={payoutStatusSchema.options.map((s) => ({ value: s, label: humanize(s) }))} />
      </FilterBar>
      <DataTable
        caption="Payouts"
        rows={rows}
        rowKey={(p) => p.id}
        rowLabel={(p) => `${p.organizationName} payout`}
        emptyMessage="No payouts in this view."
        columns={[
          { key: 'org', header: 'Owner', cell: (p) => <span>{p.organizationName}<span className="block text-xs text-fg-muted">{humanize(p.kind)} · {formatDateTimeLabel(p.createdAt)}</span></span> },
          { key: 'amt', header: 'Amount', cell: (p) => <Money kobo={p.amountKobo} currency={p.currency} /> },
          { key: 'st', header: 'Status', cell: (p) => <StatusBadge status={p.status === 'settled' ? 'successful' : p.status === 'proposed' ? 'pending' : p.status} label={humanize(p.status)} /> },
          { key: 'ben', header: 'Beneficiary', cell: (p) => beneficiaryLabel(p.beneficiary), hideOnMobile: true },
          { key: 'who', header: 'Proposed · 1st · 2nd', cell: (p) => `${p.proposedByName ?? '—'} · ${p.firstApproverName ?? '—'} · ${p.secondApproverName ?? '—'}`, hideOnMobile: true },
          {
            key: 'act',
            header: 'Next step',
            cell: (p) => (
              <span className="flex flex-wrap gap-1">
                {p.status === 'proposed' && perms.first ? (
                  <ApiAction path={`/api/v1/payouts/${p.id}/first-approve`} label="First approval" variant="primary" disabled={p.proposedBy === me} disabledReason="You proposed this payout; someone else gives the first approval." confirm={{ title: 'Give the first approval?', description: 'Checks that the statement reconciliation is balanced.', confirmLabel: 'Approve' }} successMessage="First approval recorded" />
                ) : null}
                {p.status === 'first_approved' && perms.second ? (
                  <ApiAction path={`/api/v1/payouts/${p.id}/second-approve`} label="Second approval" variant="primary" disabled={p.firstApproverId === me || p.proposedBy === me} disabledReason="Second approval must come from a third person (not the proposer or first approver)." confirm={{ title: 'Give the second approval?', description: 'Posts the owner distribution journal. The payout can then be submitted to the bank.', confirmLabel: 'Approve' }} successMessage="Payout approved" />
                ) : null}
                {['proposed', 'first_approved'].includes(p.status) && perms.first ? (
                  <ApiAction path={`/api/v1/payouts/${p.id}/reject`} reasonKey="reason" label="Reject" variant="ghost" confirm={{ title: 'Reject this payout?', requireReason: true, confirmLabel: 'Reject', tone: 'danger' }} successMessage="Payout rejected" />
                ) : null}
                {p.status === 'approved' && perms.reconcile ? (
                  <ApiAction path={`/api/v1/payouts/${p.id}/submit`} label="Mark submitted to bank" confirm={{ title: 'Mark as submitted?', description: 'Record that the transfer instruction was sent. It is not settled until the bank confirms.', confirmLabel: 'Mark submitted' }} successMessage="Marked submitted" />
                ) : null}
                {p.status === 'submitted' && perms.reconcile ? (
                  <>
                    <FormDialog trigger="Record settlement" title="Record settlement" description="Enter the bank's settlement reference from the statement." path={`/api/v1/payouts/${p.id}/settle`} successMessage="Settlement recorded" fields={[{ name: 'settlementReference', label: 'Settlement reference', required: true }]} />
                    <ApiAction path={`/api/v1/payouts/${p.id}/fail`} reasonKey="reason" label="Mark failed" variant="ghost" confirm={{ title: 'Mark as failed?', requireReason: true, confirmLabel: 'Mark failed', tone: 'danger' }} successMessage="Marked failed" />
                  </>
                ) : null}
                {p.failureReason ? <span className="text-xs text-fg-muted">{p.failureReason}</span> : null}
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
