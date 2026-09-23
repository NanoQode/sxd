import type { Metadata } from 'next';
import Link from 'next/link';
import { DataTable, EmptyState, PageHeader, StatusBadge, formatDateLabel } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { koboToNaira } from '@/lib/portal/format';
import { loadOwnerStatements, propertyNames } from '@/lib/portal/server/rentals';
import { LinkButton } from '@/components/portal/link-button';

export const metadata: Metadata = { title: 'Owner statements' };
export const dynamic = 'force-dynamic';

/** Period statements for the organisation's managed properties (reconciled or issued only). */
export default async function OwnerStatementsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const identity = await requireSignedIn('/portal/properties/statements');
  const { cursor } = await searchParams;
  const page = await loadOwnerStatements(identity, { cursor });
  const names = await propertyNames(
    identity,
    page.items.map((s) => s.propertyId),
  );
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/portal/properties" className="underline">
            Properties
          </Link>
        }
        title="Owner statements"
        description="Rent collected, management fees, maintenance recoveries and the net payable for each period. Only statements finance has reconciled to the ledger appear here."
      />
      {page.items.length === 0 ? (
        <EmptyState
          title="No statements yet"
          description="Statements are produced for properties SimplexD manages once a period closes and finance reconciles it. Drafts are never shown."
          action={
            <LinkButton href="/portal/properties" variant="secondary">
              Back to properties
            </LinkButton>
          }
        />
      ) : (
        <DataTable
          caption="Owner statements"
          rows={page.items}
          rowKey={(s) => s.id}
          rowLabel={(s) => `Statement ${s.periodStart} to ${s.periodEnd}`}
          columns={[
            {
              key: 'period',
              header: 'Period',
              cell: (s) => (
                <Link
                  href={`/portal/properties/statements/${s.id}`}
                  className="font-medium text-primary underline"
                >
                  {formatDateLabel(s.periodStart, zone)} – {formatDateLabel(s.periodEnd, zone)}
                </Link>
              ),
            },
            {
              key: 'property',
              header: 'Property',
              cell: (s) =>
                s.propertyId ? (names.get(s.propertyId) ?? 'Property') : 'Portfolio / estate',
            },
            {
              key: 'collected',
              header: 'Collected',
              cell: (s) => koboToNaira(s.totals.collectedKobo),
              className: 'text-right',
              hideOnMobile: true,
            },
            {
              key: 'net',
              header: 'Net payable',
              cell: (s) => koboToNaira(s.totals.netKobo),
              className: 'text-right',
            },
            { key: 'status', header: 'Status', cell: (s) => <StatusBadge status={s.status} /> },
          ]}
        />
      )}
      {page.nextCursor ? (
        <Link
          href={`/portal/properties/statements?cursor=${encodeURIComponent(page.nextCursor)}`}
          className="sx-touch inline-flex items-center rounded-md border border-border-strong px-4 text-sm"
        >
          Older statements
        </Link>
      ) : null}
    </div>
  );
}
