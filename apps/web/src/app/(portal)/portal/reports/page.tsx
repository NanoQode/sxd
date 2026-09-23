import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, DataTable, EmptyState, PageHeader, formatDateLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { listDocuments } from '@/server/portal/lists';

export const metadata: Metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const identity = await requireSignedIn('/portal/reports');
  const { reports } = await listDocuments(identity);
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Released reports across your projects and requests: progress, inspection, diligence memoranda, valuations and closing packs. Drafts and internal reviews are never shown."
      />
      {reports.length === 0 ? (
        <EmptyState
          title="No released reports"
          description="Reports are produced during engagements and appear once a named reviewer releases them."
        />
      ) : (
        <DataTable
          caption="Released reports"
          rows={reports}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.title}
          columns={[
            {
              key: 'title',
              header: 'Report',
              cell: (r) => (
                <Link
                  href={`/portal/reports/${r.id}`}
                  className="font-medium text-primary underline"
                >
                  {r.title}
                </Link>
              ),
            },
            {
              key: 'kind',
              header: 'Kind',
              cell: (r) => <Badge tone="info">{humanize(r.kind)}</Badge>,
            },
            {
              key: 'version',
              header: 'Version',
              cell: (r) => (r.releasedVersion ? `v${r.releasedVersion}` : '—'),
            },
            {
              key: 'released',
              header: 'Released',
              cell: (r) => (r.releasedAt ? formatDateLabel(r.releasedAt, zone) : '—'),
            },
          ]}
        />
      )}
    </div>
  );
}
