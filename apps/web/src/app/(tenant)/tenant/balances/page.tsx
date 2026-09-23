import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@simplexd/ui';
import { ArrearsAgeing, BalanceFigures } from '@/components/tenant/balance-summary';
import { ChargesTable, InvoicesTable } from '@/components/tenant/ledger-tables';
import { LeaseSwitcher } from '@/components/tenant/lease-switcher';
import { LoadError } from '@/components/tenant/load-error';
import { NoTenancy } from '@/components/tenant/no-tenancy';
import { PayInvoiceButton } from '@/components/tenant/pay-invoice-button';
import { requireSignedIn } from '@/lib/auth/session';
import {
  INVOICE_PAYABLE_STATUSES,
  depositOutstandingKobo,
  formatMoney,
  isPositiveKobo,
  leaseTitle,
  pickCurrentLease,
  type TenantInvoice,
} from '@/lib/tenant/model';
import {
  loadBalance,
  loadCharges,
  loadMyInvoices,
  loadMyLeases,
  loadPaymentResult,
} from '@/lib/tenant/server/data';

export const metadata: Metadata = { title: 'Balances' };
export const dynamic = 'force-dynamic';

const DESCRIPTION =
  'What you owe on your lease, how long it has been outstanding, and every charge and invoice behind it.';

/**
 * Balance, arrears ageing, invoices and charges for one of the caller's
 * leases (`?lease=`). Only the caller's own obligations are read: the owner
 * ledger (fees, statements, payouts) is never requested.
 */
export default async function TenantBalancesPage({
  searchParams,
}: {
  searchParams: Promise<{ lease?: string; attempt?: string }>;
}) {
  const identity = await requireSignedIn('/tenant/balances');
  const { lease: leaseParam, attempt: attemptParam } = await searchParams;
  const leases = await loadMyLeases(identity);
  if (!leases.ok) {
    return (
      <div className="space-y-6">
        <PageHeader title="Balances" description={DESCRIPTION} />
        <LoadError title="Your leases could not be loaded" error={leases.error} />
      </div>
    );
  }
  if (leases.data.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Balances" description={DESCRIPTION} />
        <NoTenancy
          email={identity.session!.user.email}
          hasPortal={identity.actor.memberships.length > 0}
        />
      </div>
    );
  }
  const selected =
    leases.data.find((l) => l.lease.id === leaseParam) ?? pickCurrentLease(leases.data)!;
  const { lease } = selected;
  const [balance, charges, invoices] = await Promise.all([
    loadBalance(identity, lease.id),
    loadCharges(identity, lease.id),
    loadMyInvoices(identity, [lease.id]),
  ]);
  const paymentResult = attemptParam ? await loadPaymentResult(identity, attemptParam) : null;
  const payable = (i: TenantInvoice) =>
    INVOICE_PAYABLE_STATUSES.has(i.status) && isPositiveKobo(i.balanceKobo);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/tenant" className="underline">
            Tenant home
          </Link>
        }
        title="Balances"
        description={DESCRIPTION}
      />
      {paymentResult ? (
        <Alert tone={paymentResult.tone} title={paymentResult.title}>
          {paymentResult.message}
        </Alert>
      ) : null}
      <LeaseSwitcher
        basePath="/tenant/balances"
        selectedId={lease.id}
        leases={leases.data.map((l) => ({
          id: l.lease.id,
          title: leaseTitle(l),
          status: l.lease.status,
        }))}
      />
      <p className="text-sm text-fg-muted">
        Showing <strong className="text-fg">{leaseTitle(selected)}</strong>.{' '}
        <Link href={`/tenant/lease/${lease.id}`} className="text-primary underline">
          Lease terms and rent schedule
        </Link>
      </p>

      <section aria-labelledby="balance-heading" className="space-y-3">
        <h2 id="balance-heading" className="text-lg font-semibold">
          Summary
        </h2>
        {balance.ok ? (
          <BalanceFigures
            balance={balance.data}
            depositOutstandingKobo={charges.ok ? depositOutstandingKobo(charges.data) : undefined}
          />
        ) : (
          <LoadError title="Your balance could not be loaded" error={balance.error} />
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Arrears ageing</CardTitle>
          <CardDescription>
            Unpaid amounts grouped by how long they are past their due date.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {balance.ok ? (
            <ArrearsAgeing balance={balance.data} />
          ) : (
            <LoadError title="Arrears could not be loaded" error={balance.error} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
          <CardDescription>
            Invoices issued to you for this lease. Paid invoices have a receipt on{' '}
            <Link href="/tenant/receipts" className="text-primary underline">
              Receipts
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!invoices.ok ? (
            <LoadError title="Your invoices could not be loaded" error={invoices.error} />
          ) : (
            <>
              <InvoicesTable
                invoices={invoices.data}
                payAction={(i) =>
                  payable(i) ? (
                    <PayInvoiceButton
                      invoiceId={i.id}
                      invoiceNumber={i.number}
                      amountLabel={formatMoney(i.balanceKobo, i.currency)}
                    />
                  ) : null
                }
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Charges</CardTitle>
          <CardDescription>
            Every charge on this lease with what has been settled against it (settled money only; a
            declared transfer counts once it clears).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {charges.ok ? (
            <ChargesTable charges={charges.data} currency={lease.currency} />
          ) : (
            <LoadError title="Your charges could not be loaded" error={charges.error} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
