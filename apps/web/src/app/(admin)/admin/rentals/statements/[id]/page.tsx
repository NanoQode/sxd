import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Alert,
  Badge,
  DataTable,
  PageHeader,
  formatDateLabel,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt, can, orgNames, staffTx } from '@/lib/admin/server/context';
import { listPayouts } from '@/lib/admin/server/finance';
import { getOwnerStatement } from '@/server/rentals/owner-statements';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';
import { LoadError } from '@/components/admin/load-error';
import { Money } from '@/components/admin/money';
import { Section } from '@/components/admin/section';
import { DefinitionList } from '../../../_components/bits';

export const metadata: Metadata = { title: 'Owner statement' };
export const dynamic = 'force-dynamic';

export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  const identity = await requireSignedIn('/admin/rentals/statements');
  const { id } = await params;
  const loaded = await attempt(() => getOwnerStatement(identity, id));
  if (!loaded.ok) {
    if (loaded.code === 'not_found' || loaded.code === 'validation_failed') notFound();
    return <LoadError code={loaded.code} message={loaded.message} what="This statement" />;
  }
  const s = loaded.value;
  const [orgs, payouts] = await Promise.all([
    staffTx(identity, (tx) => orgNames(tx, [s.organizationId])),
    attempt(() => listPayouts(identity, 200)),
  ]);
  const mine = payouts.ok ? payouts.value.filter((p) => p.ownerStatementId === s.id) : [];
  const canManage = can(identity, 'rentals.manage');
  const canPropose = canManage || can(identity, 'finance.payouts.first_approve');
  const committed = mine
    .filter((p) => !['rejected', 'failed'].includes(p.status))
    .reduce((sum, p) => sum + BigInt(p.amountKobo), 0n);
  const remaining = BigInt(s.totals.netKobo) - committed;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/rentals/statements" className="underline">
            Owner statements
          </Link>
        }
        title={`${orgs.get(s.organizationId) ?? 'Owner'} · ${formatDateLabel(s.periodStart)} → ${formatDateLabel(s.periodEnd)}`}
        description={`Generated ${formatDateTimeLabel(s.generatedAt)}${s.propertyId ? ' · one property' : ''}${s.estateId ? ' · estate' : ''}`}
        actions={
          <>
            <Badge
              tone={
                s.status === 'issued' ? 'success' : s.status === 'reconciled' ? 'info' : 'neutral'
              }
            >
              {humanize(s.status)}
            </Badge>
            {canManage && s.status === 'draft' ? (
              <ApiAction
                path={`/api/v1/owner-statements/${s.id}/reconcile`}
                label="Reconcile"
                variant="primary"
                confirm={{
                  title: 'Reconcile this statement?',
                  description:
                    'Posts the management-fee and maintenance-recovery journals, then checks every figure against allocations and journal lines. It stays a draft if anything does not match.',
                  confirmLabel: 'Reconcile',
                }}
                successMessage="Reconciliation run"
              />
            ) : null}
            {canManage && s.status === 'reconciled' ? (
              <ApiAction
                path={`/api/v1/owner-statements/${s.id}/issue`}
                label="Issue to owner"
                variant="primary"
                confirm={{
                  title: 'Issue to the owner?',
                  description: 'The owner can then see the statement.',
                  confirmLabel: 'Issue',
                }}
                successMessage="Statement issued"
              />
            ) : null}
            {canPropose && ['reconciled', 'issued'].includes(s.status) && remaining > 0n ? (
              <FormDialog
                trigger="Propose payout"
                title="Propose an owner distribution"
                description={`Up to ${remaining.toString()} kobo remains payable on this statement. Two different finance approvers must approve before submission.`}
                path="/api/v1/payouts"
                idempotent
                successMessage="Payout proposed"
                redirectTo="/admin/rentals/payouts/{id}"
                extraBody={{ ownerStatementId: s.id }}
                fields={[
                  {
                    name: 'amountKobo',
                    label: 'Amount (₦, blank = full net payable)',
                    type: 'naira',
                  },
                  {
                    name: 'accountName',
                    label: 'Account name',
                    required: true,
                    bodyKey: 'beneficiary.accountName',
                  },
                  {
                    name: 'bankName',
                    label: 'Bank',
                    required: true,
                    bodyKey: 'beneficiary.bankName',
                  },
                  {
                    name: 'accountNumberMasked',
                    label: 'Account number (masked, e.g. ******1234)',
                    required: true,
                    bodyKey: 'beneficiary.accountNumberMasked',
                  },
                ]}
              />
            ) : null}
          </>
        }
      />
      {s.reconciliation && !s.reconciliation.matches ? (
        <Alert tone="danger" title="Reconciliation conflict">
          The ledger does not match the statement figures. Investigate before issuing: allocations{' '}
          <Money kobo={s.reconciliation.allocationsKobo} />, fee journals{' '}
          <Money kobo={s.reconciliation.feeJournalKobo} />, recovery journals{' '}
          <Money kobo={s.reconciliation.recoveryJournalKobo} />.
        </Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Section title={`Lines (${s.lines.length})`}>
          <DataTable
            caption="Statement lines"
            rows={s.lines.map((l, i) => ({ ...l, key: `${i}` }))}
            rowKey={(l) => l.key}
            rowLabel={(l) => l.description}
            emptyMessage="Nothing in this period."
            columns={[
              { key: 'k', header: 'Kind', cell: (l) => humanize(l.kind) },
              { key: 'd', header: 'Description', cell: (l) => l.description },
              { key: 'a', header: 'Amount', cell: (l) => <Money kobo={l.amountKobo} /> },
              {
                key: 'ref',
                header: 'Source',
                cell: (l) =>
                  l.invoiceId ? (
                    <Link href={`/admin/finance/invoices/${l.invoiceId}`} className="underline">
                      invoice
                    </Link>
                  ) : l.workOrderId ? (
                    <Link
                      href={`/admin/rentals/work-orders/${l.workOrderId}`}
                      className="underline"
                    >
                      work order
                    </Link>
                  ) : l.leaseId ? (
                    <Link href={`/admin/rentals/leases/${l.leaseId}`} className="underline">
                      lease
                    </Link>
                  ) : (
                    '—'
                  ),
                hideOnMobile: true,
              },
            ]}
          />
        </Section>
        <div className="space-y-6">
          <Section title="Totals">
            <DefinitionList
              items={[
                { term: 'Collected', value: <Money kobo={s.totals.collectedKobo} /> },
                { term: 'Management fees', value: <Money kobo={s.totals.feesKobo} /> },
                { term: 'Maintenance recovered', value: <Money kobo={s.totals.expensesKobo} /> },
                {
                  term: 'Net payable to owner',
                  value: (
                    <strong>
                      <Money kobo={s.totals.netKobo} />
                    </strong>
                  ),
                },
                { term: 'Arrears (not netted)', value: <Money kobo={s.totals.arrearsKobo} /> },
                {
                  term: 'Reconciled',
                  value: s.reconciledAt ? formatDateTimeLabel(s.reconciledAt) : null,
                },
                { term: 'Issued', value: s.issuedAt ? formatDateTimeLabel(s.issuedAt) : null },
              ]}
            />
            {s.totals.openObligations.length > 0 ? (
              <div>
                <p className="font-medium">Open obligations</p>
                <ul className="mt-1 space-y-1">
                  {s.totals.openObligations.map((o, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span>{o.description}</span>
                      <Money kobo={o.amountKobo} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Section>
          <Section title={`Payouts (${mine.length})`}>
            {mine.length === 0 ? (
              <p className="text-fg-muted">No payouts proposed.</p>
            ) : (
              <ul className="space-y-1">
                {mine.map((p) => (
                  <li key={p.id} className="flex flex-wrap justify-between gap-2">
                    <Link href={`/admin/rentals/payouts/${p.id}`} className="underline">
                      <Money kobo={p.amountKobo} currency={p.currency} />
                    </Link>
                    <Badge>{humanize(p.status)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
