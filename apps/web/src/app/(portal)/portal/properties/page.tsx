import type { Metadata } from 'next';
import Link from 'next/link';
import { DataTable, EmptyState, PageHeader, StatusBadge, formatDateLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { listProperties } from '@/server/portal/lists';

export const metadata: Metadata = { title: 'Properties' };
export const dynamic = 'force-dynamic';

export default async function PropertiesPage() {
  const identity = await requireSignedIn('/portal/properties');
  const properties = await listProperties(identity);
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  return (
    <div className="space-y-6">
      <PageHeader
        title="Properties"
        description="Land, buildings and units your organisation owns or manages through SimplexD, with title status that states what was checked."
      />
      {properties.length === 0 ? (
        <EmptyState
          title="No properties on record"
          description="A property record is created when an engagement starts on it: due diligence, monitoring, management or a listing mandate. Start a request and the team sets up the property with you."
          action={
            <Link href="/portal/requests/new" className="sx-touch inline-flex items-center rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary">
              Request a service
            </Link>
          }
        />
      ) : (
        <DataTable
          caption="Properties"
          rows={properties}
          rowKey={(p) => p.id}
          rowLabel={(p) => p.name}
          columns={[
            { key: 'name', header: 'Property', cell: (p) => <span className="font-medium">{p.name}</span> },
            { key: 'kind', header: 'Type', cell: (p) => humanize(p.kind) },
            { key: 'market', header: 'Market', cell: (p) => p.marketName ?? '—' },
            { key: 'title', header: 'Title status', cell: (p) => <StatusBadge status={p.titleStatus} /> },
            { key: 'updated', header: 'Updated', cell: (p) => formatDateLabel(p.updatedAt, zone), hideOnMobile: true },
          ]}
        />
      )}
    </div>
  );
}
