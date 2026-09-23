import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, PageHeader, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt, can, orgNames, staffTx, userNames } from '@/lib/admin/server/context';
import { getPayout } from '@/server/rentals/payouts';
import { LoadError } from '@/components/admin/load-error';
import { Money } from '@/components/admin/money';
import { PayoutActions } from '@/components/admin/payout-actions';
import { Section } from '@/components/admin/section';
import { DefinitionList, Mono } from '../../../_components/bits';

export const metadata: Metadata = { title: 'Payout' };
export const dynamic = 'force-dynamic';

const STEPS = ['proposed', 'first_approved', 'approved', 'submitted', 'settled'];

export default async function PayoutPage({ params }: { params: Promise<{ id: string }> }) {
  const identity = await requireSignedIn('/admin/rentals/payouts');
  const { id } = await params;
  const loaded = await attempt(() => getPayout(identity, id));
  if (!loaded.ok) {
    if (loaded.code === 'not_found' || loaded.code === 'validation_failed') notFound();
    return <LoadError code={loaded.code} message={loaded.message} what="This payout" />;
  }
  const p = loaded.value;
  const [orgs, names] = await staffTx(
    identity,
    async (tx) =>
      [
        await orgNames(tx, [p.organizationId]),
        await userNames(tx, [p.proposedBy, p.firstApproverId, p.secondApproverId]),
      ] as const,
  );
  const name = (uid: string | null) => (uid ? (names.get(uid)?.name ?? uid) : null);
  const me = identity.session!.user.id;
  const perms = {
    first: can(identity, 'finance.payouts.first_approve'),
    second: can(identity, 'finance.payouts.second_approve'),
    reconcile: can(identity, 'finance.reconcile'),
  };
  const b = (p.beneficiary ?? {}) as Record<string, unknown>;
  const step = STEPS.indexOf(p.status);
  const involved = [p.proposedBy, p.firstApproverId].includes(me);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/rentals/payouts" className="underline">
            Payouts
          </Link>
        }
        title={`Payout to ${orgs.get(p.organizationId) ?? 'owner'}`}
        description={`${humanize(p.kind)} · proposed ${formatDateTimeLabel(p.createdAt)}`}
        actions={
          <>
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
            <PayoutActions payout={p} me={me} perms={perms} />
          </>
        }
      />
      {(perms.first || perms.second) && !identity.actor.mfaVerified ? (
        <Alert tone="warning" title="Approvals need your authenticator">
          <Link href="/admin/security/mfa" className="underline">
            Verify multi-factor authentication
          </Link>{' '}
          before approving.
        </Alert>
      ) : null}
      {involved && ['proposed', 'first_approved'].includes(p.status) ? (
        <Alert tone="info" title="Separation of duties">
          You already took part in this payout, so the next approval must come from someone else.
        </Alert>
      ) : null}
      {p.failureReason ? (
        <Alert tone="danger" title={p.status === 'rejected' ? 'Rejected' : 'Failed'}>
          {p.failureReason}
        </Alert>
      ) : null}
      <ol className="flex flex-wrap gap-1 text-xs" aria-label="Payout progress">
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={s === p.status ? 'step' : undefined}
            className={`rounded-full border px-2 py-0.5 ${s === p.status ? 'border-primary bg-primary-soft text-primary' : step >= 0 && i < step ? 'border-success/50 text-success' : 'border-border text-fg-muted'}`}
          >
            {humanize(s)}
          </li>
        ))}
      </ol>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Amount and beneficiary">
          <DefinitionList
            items={[
              {
                term: 'Amount',
                value: (
                  <strong>
                    <Money kobo={p.amountKobo} currency={p.currency} />
                  </strong>
                ),
              },
              { term: 'Account name', value: b.accountName ? String(b.accountName) : null },
              { term: 'Bank', value: b.bankName ? String(b.bankName) : null },
              {
                term: 'Account',
                value: b.accountNumberMasked ? <Mono>{String(b.accountNumberMasked)}</Mono> : null,
              },
              {
                term: 'Owner statement',
                value: p.ownerStatementId ? (
                  <Link
                    href={`/admin/rentals/statements/${p.ownerStatementId}`}
                    className="underline"
                  >
                    open statement
                  </Link>
                ) : null,
              },
            ]}
          />
        </Section>
        <Section title="Approvals and settlement">
          <DefinitionList
            items={[
              { term: 'Proposed by', value: name(p.proposedBy) },
              {
                term: 'First approval',
                value: p.firstApproverId
                  ? `${name(p.firstApproverId)} · ${p.firstApprovedAt ? formatDateTimeLabel(p.firstApprovedAt) : ''}`
                  : null,
              },
              {
                term: 'Second approval',
                value: p.secondApproverId
                  ? `${name(p.secondApproverId)} · ${p.secondApprovedAt ? formatDateTimeLabel(p.secondApprovedAt) : ''}`
                  : null,
              },
              {
                term: 'Submitted',
                value: p.submittedAt ? formatDateTimeLabel(p.submittedAt) : null,
              },
              { term: 'Settled', value: p.settledAt ? formatDateTimeLabel(p.settledAt) : null },
              {
                term: 'Journal',
                value: p.journalId ? (
                  <Link href="/admin/finance/journals?sourceType=payout" className="underline">
                    <Mono>{p.journalId.slice(0, 8)}</Mono>
                  </Link>
                ) : null,
              },
              {
                term: 'Reconciliation',
                value: p.reconciliationId ? <Mono>{p.reconciliationId.slice(0, 8)}</Mono> : null,
              },
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
