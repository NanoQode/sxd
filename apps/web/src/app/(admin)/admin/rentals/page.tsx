import type { Metadata } from 'next';
import Link from 'next/link';
import { leaseStatusSchema, type LeaseListQuery } from '@simplexd/contracts';
import { DataTable, PageHeader, StatusBadge, formatDateLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt, can } from '@/lib/admin/server/context';
import { searchOrganizations } from '@/lib/admin/server/customers';
import { listAllProperties } from '@/lib/admin/server/properties';
import { listLeasesView } from '@/lib/admin/server/rentals';
import { ExportCsvButton } from '@/components/admin/export-csv-button';
import { FilterBar, FilterSelect } from '@/components/admin/filter-bar';
import { LoadError } from '@/components/admin/load-error';
import { Money } from '@/components/admin/money';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';
import { LeaseCreateDialog } from './_components/lease-create-dialog';

export const metadata: Metadata = { title: 'Rentals / Maintenance' };
export const dynamic = 'force-dynamic';

export default async function LeasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireSignedIn('/admin/rentals');
  const raw = await searchParams;
  const status = leaseStatusSchema.safeParse(raw.status).success
    ? (raw.status as LeaseListQuery['status'])
    : undefined;
  const [loaded, orgs, props] = await Promise.all([
    attempt(() =>
      listLeasesView(identity, {
        status,
        organizationId: raw.organizationId || undefined,
        cursor: raw.cursor || undefined,
        limit: 50,
      }),
    ),
    attempt(() => searchOrganizations(identity, undefined, 500)),
    attempt(() => listAllProperties(identity, { status: 'active' })),
  ]);
  if (!loaded.ok) return <LoadError code={loaded.code} message={loaded.message} what="Leases" />;
  const rows = loaded.value.items;
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) if (v && k !== 'cursor') next.set(k, v);
  if (loaded.value.nextCursor) next.set('cursor', loaded.value.nextCursor);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Leases"
        description="Leases on owners' properties. Rent collected is held for the owner (a liability), never SimplexD revenue; only the agreed management fee is revenue. Open a lease for its schedule, charges, arrears ageing, parties and notices."
        actions={
          can(identity, 'rentals.manage') && props.ok ? (
            <LeaseCreateDialog
              properties={props.value.items.map((p) => ({ id: p.id, name: p.name }))}
            />
          ) : undefined
        }
      />
      <SavedViewsBar tableKey="rentals-leases" />
      <FilterBar>
        <FilterSelect
          name="status"
          label="Status"
          value={status}
          options={leaseStatusSchema.options.map((s) => ({ value: s, label: humanize(s) }))}
        />
        <FilterSelect
          name="organizationId"
          label="Owner organisation"
          value={raw.organizationId}
          allLabel="All"
          options={(orgs.ok ? orgs.value : []).map((o) => ({ value: o.id, label: o.name }))}
        />
      </FilterBar>
      <div className="flex justify-end">
        <ExportCsvButton
          rows={rows}
          filename="leases.csv"
          columns={[
            { header: 'Lease id', value: (l) => l.id },
            { header: 'Owner', value: (l) => l.organizationName },
            { header: 'Property', value: (l) => l.propertyName },
            { header: 'Unit', value: (l) => l.unitLabel },
            { header: 'Tenants', value: (l) => l.tenantNames.join('|') },
            { header: 'Status', value: (l) => l.status },
            { header: 'Start', value: (l) => l.startDate },
            { header: 'End', value: (l) => l.endDate },
            { header: 'Rent kobo', value: (l) => l.rentAmountKobo },
            { header: 'Period', value: (l) => l.rentPeriod },
          ]}
        />
      </div>
      <DataTable
        caption="Leases"
        rows={rows}
        rowKey={(l) => l.id}
        rowLabel={(l) => `${l.propertyName ?? 'property'} ${l.unitLabel ?? ''}`}
        emptyMessage="No leases in this view."
        columns={[
          {
            key: 'where',
            header: 'Property / unit',
            cell: (l) => (
              <span>
                <Link
                  href={`/admin/rentals/leases/${l.id}`}
                  className="font-medium text-primary underline"
                >
                  {l.propertyName ?? 'Property'}
                  {l.unitLabel ? ` · ${l.unitLabel}` : ''}
                </Link>
                <span className="block text-xs text-fg-muted">{l.organizationName}</span>
              </span>
            ),
          },
          {
            key: 'tenant',
            header: 'Tenants',
            cell: (l) =>
              l.tenantNames.length ? (
                l.tenantNames.join(', ')
              ) : (
                <span className="text-fg-muted">none invited</span>
              ),
          },
          {
            key: 'st',
            header: 'Status',
            cell: (l) => (
              <StatusBadge
                status={
                  l.status === 'active'
                    ? 'in_progress'
                    : l.status === 'expiring'
                      ? 'overdue'
                      : l.status === 'ended'
                        ? 'completed'
                        : l.status === 'terminated'
                          ? 'cancelled'
                          : l.status
                }
                label={humanize(l.status)}
              />
            ),
          },
          {
            key: 'term',
            header: 'Term',
            cell: (l) =>
              `${formatDateLabel(l.startDate)} → ${l.endDate ? formatDateLabel(l.endDate) : 'open'}`,
            hideOnMobile: true,
          },
          {
            key: 'rent',
            header: 'Rent',
            cell: (l) => (
              <span>
                <Money kobo={l.rentAmountKobo} currency={l.currency} /> / {l.rentPeriod}
              </span>
            ),
          },
          { key: 'kind', header: 'Kind', cell: (l) => humanize(l.kind), hideOnMobile: true },
        ]}
      />
      {loaded.value.nextCursor ? (
        <Link href={`/admin/rentals?${next.toString()}`} className="text-sm underline">
          Next page
        </Link>
      ) : null}
    </div>
  );
}
