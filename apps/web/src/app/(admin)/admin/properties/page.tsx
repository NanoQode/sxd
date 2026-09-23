import type { Metadata } from 'next';
import Link from 'next/link';
import { propertyKindSchema, propertyStatusSchema } from '@simplexd/contracts';
import {
  DataTable,
  EmptyState,
  PageHeader,
  StatusBadge,
  formatArea,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { orgNames, requireAnyStaff, staffTx } from '@/lib/admin/server/context';
import { searchOrganizations } from '@/lib/admin/server/customers';
import { listAllProperties } from '@/lib/admin/server/properties';
import { listProperties } from '@/server/properties/service';
import { FilterBar, FilterInput, FilterSelect } from '@/components/admin/filter-bar';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';

export const metadata: Metadata = { title: 'Properties' };
export const dynamic = 'force-dynamic';

export default async function PropertiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireSignedIn('/admin/properties');
  requireAnyStaff(identity, ['customers.read', 'projects.read_all']);
  const raw = await searchParams;
  const kind = propertyKindSchema.safeParse(raw.kind).success ? (raw.kind as never) : undefined;
  const status = propertyStatusSchema.safeParse(raw.status).success
    ? (raw.status as never)
    : 'active';
  const organizationId = raw.organizationId || undefined;
  const [page, orgs] = await Promise.all([
    organizationId
      ? listProperties(identity, {
          kind,
          status,
          q: raw.q?.trim() || undefined,
          organizationId,
          cursor: raw.cursor,
          limit: 50,
        })
      : listAllProperties(identity, { kind, status, q: raw.q?.trim() || undefined }),
    searchOrganizations(identity, undefined, 200),
  ]);
  const names = await staffTx(identity, (tx) =>
    orgNames(
      tx,
      page.items.map((p) => p.organizationId),
    ),
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title="Properties"
        description="Private property assets across customer organisations: parcels, units, title status and owner authority. Public listings are a separate record."
      />
      <SavedViewsBar tableKey="properties" />
      <FilterBar>
        <FilterSelect
          name="organizationId"
          label="Organisation"
          value={organizationId}
          allLabel="All organisations"
          options={orgs.map((o) => ({ value: o.id, label: o.name }))}
        />
        <FilterSelect
          name="kind"
          label="Kind"
          value={kind}
          options={propertyKindSchema.options.map((k) => ({ value: k, label: humanize(k) }))}
        />
        <FilterSelect
          name="status"
          label="Status"
          value={status === 'active' ? undefined : status}
          allLabel="Active"
          options={[{ value: 'archived', label: 'Archived' }]}
        />
        <FilterInput name="q" label="Search" value={raw.q} placeholder="Name or city" />
      </FilterBar>
      {page.items.length === 0 ? (
        <EmptyState
          title="No properties match"
          description="Customers add properties from their portal (Properties → Add). Staff create one on a customer's behalf through the same API with the organisation named."
        />
      ) : (
        <DataTable
          caption="Properties"
          rows={page.items}
          rowKey={(p) => p.id}
          rowLabel={(p) => p.name}
          columns={[
            {
              key: 'name',
              header: 'Property',
              cell: (p) => (
                <Link
                  href={`/admin/properties/${p.id}`}
                  className="font-medium text-primary underline"
                >
                  {p.name}
                </Link>
              ),
            },
            {
              key: 'org',
              header: 'Organisation',
              cell: (p) => (
                <Link href={`/admin/customers/${p.organizationId}`} className="underline">
                  {names.get(p.organizationId) ?? p.organizationId}
                </Link>
              ),
            },
            { key: 'kind', header: 'Kind', cell: (p) => humanize(p.kind) },
            {
              key: 'city',
              header: 'City / state',
              cell: (p) => [p.address?.city, p.address?.state].filter(Boolean).join(', ') || '—',
            },
            {
              key: 'area',
              header: 'Land area',
              cell: (p) =>
                p.landArea
                  ? p.landArea.m2
                    ? formatArea(p.landArea.m2)
                    : `${p.landArea.declaredValue} ${p.landArea.declaredUnit}`
                  : '—',
              hideOnMobile: true,
            },
            { key: 'title', header: 'Title', cell: (p) => <StatusBadge status={p.titleStatus} /> },
            {
              key: 'updated',
              header: 'Updated',
              cell: (p) => formatDateTimeLabel(p.updatedAt),
              hideOnMobile: true,
            },
          ]}
        />
      )}
      {page.nextCursor && organizationId ? (
        <Link
          href={`/admin/properties?${new URLSearchParams({ ...(Object.fromEntries(Object.entries(raw).filter(([, v]) => v)) as Record<string, string>), cursor: page.nextCursor }).toString()}`}
          className="sx-touch inline-flex items-center rounded-md border border-border-strong px-4 text-sm"
        >
          Load more
        </Link>
      ) : null}
    </div>
  );
}
