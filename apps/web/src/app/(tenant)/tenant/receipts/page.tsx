import { ReceiptText } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { DataTable, EmptyState, PageHeader, formatDateTimeLabel } from '@simplexd/ui';
import { LoadError } from '@/components/tenant/load-error';
import { NoTenancy } from '@/components/tenant/no-tenancy';
import { requireSignedIn } from '@/lib/auth/session';
import { formatMoney } from '@/lib/tenant/model';
import { loadMyLeases, loadReceipts, zoneOf } from '@/lib/tenant/server/data';

export const metadata: Metadata = { title: 'Receipts' };
export const dynamic = 'force-dynamic';

const DESCRIPTION =
  'Receipts for payments recorded against invoices issued to you for your leases. A receipt is issued only after the money is confirmed.';

export default async function TenantReceiptsPage() {
  const identity = await requireSignedIn('/tenant/receipts');
  const zone = zoneOf(identity);
  const [leases, receipts] = await Promise.all([loadMyLeases(identity), loadReceipts(identity)]);
  const header = (
    <PageHeader
      eyebrow={
        <Link href="/tenant" className="underline">
          Tenant home
        </Link>
      }
      title="Receipts"
      description={DESCRIPTION}
    />
  );
  if (leases.ok && leases.data.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        <NoTenancy
          email={identity.session!.user.email}
          hasPortal={identity.actor.memberships.length > 0}
        />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {header}
      {!receipts.ok ? (
        <LoadError title="Your receipts could not be loaded" error={receipts.error} />
      ) : receipts.data.length === 0 ? (
        <EmptyState
          icon={<ReceiptText aria-hidden="true" className="h-8 w-8" />}
          title="No receipts yet"
          description="When a payment on one of your invoices is confirmed, its receipt appears here. Check Balances for what is outstanding."
          action={
            <Link
              href="/tenant/balances"
              className="sx-touch inline-flex items-center rounded-md border border-border-strong px-4 text-sm font-medium"
            >
              Go to balances
            </Link>
          }
        />
      ) : (
        <DataTable
          caption="Your receipts"
          rows={receipts.data}
          rowKey={(r) => r.id}
          rowLabel={(r) => `Receipt ${r.number}`}
          columns={[
            { key: 'number', header: 'Receipt', hideOnMobile: true, cell: (r) => r.number },
            { key: 'invoice', header: 'For invoice', cell: (r) => r.invoiceNumber },
            {
              key: 'issued',
              header: 'Issued',
              cell: (r) => (
                <time dateTime={r.issuedAt}>{formatDateTimeLabel(r.issuedAt, zone)}</time>
              ),
            },
            {
              key: 'amount',
              header: 'Amount',
              className: 'text-right tabular-nums',
              cell: (r) => formatMoney(r.amountKobo),
            },
          ]}
        />
      )}
    </div>
  );
}
