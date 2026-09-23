import type { Metadata } from 'next';
import Link from 'next/link';
import {
  DataTable,
  EmptyState,
  PageHeader,
  StatusBadge,
  formatDateLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { customerCapabilities } from '@/lib/portal/server/permissions';
import { LinkButton } from '@/components/portal/link-button';
import { listProperties } from '@/server/portal/lists';

export const metadata: Metadata = { title: 'Properties' };
export const dynamic = 'force-dynamic';

export default async function PropertiesPage() {
  const identity = await requireSignedIn('/portal/properties');
  const properties = await listProperties(identity);
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const caps = customerCapabilities(identity);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Properties"
        description="Land, buildings and units your organisation owns or manages through SimplexD, with title status that states what was checked."
        actions={
          caps.manageProperties ? (
            <LinkButton href="/portal/properties/new">Add a property</LinkButton>
          ) : undefined
        }
      />
      {properties.length === 0 ? (
        <EmptyState
          title="No properties on record"
          description={
            caps.manageProperties
              ? 'Add a property yourself, or start a request and the team sets it up with you. Title status starts as "unknown" until documents are checked.'
              : 'A property record is created when an engagement starts on it: due diligence, monitoring, management or a listing mandate.'
          }
          action={
            caps.manageProperties ? (
              <LinkButton href="/portal/properties/new">Add a property</LinkButton>
            ) : (
              <LinkButton href="/portal/requests/new">Request a service</LinkButton>
            )
          }
        />
      ) : (
        <DataTable
          caption="Properties"
          rows={properties}
          rowKey={(p) => p.id}
          rowLabel={(p) => p.name}
          columns={[
            {
              key: 'name',
              header: 'Property',
              cell: (p) => (
                <Link
                  href={`/portal/properties/${p.id}`}
                  className="font-medium text-primary underline"
                >
                  {p.name}
                </Link>
              ),
            },
            { key: 'kind', header: 'Type', cell: (p) => humanize(p.kind) },
            { key: 'market', header: 'Market', cell: (p) => p.marketName ?? '—' },
            {
              key: 'title',
              header: 'Title status',
              cell: (p) => <StatusBadge status={p.titleStatus} />,
            },
            {
              key: 'updated',
              header: 'Updated',
              cell: (p) => formatDateLabel(p.updatedAt, zone),
              hideOnMobile: true,
            },
          ]}
        />
      )}
    </div>
  );
}
