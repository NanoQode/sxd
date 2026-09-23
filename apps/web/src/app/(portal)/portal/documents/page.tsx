import type { Metadata } from 'next';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataTable, EmptyState, PageHeader, StatusBadge, formatDateLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { listDocuments } from '@/server/portal/lists';

export const metadata: Metadata = { title: 'Documents' };
export const dynamic = 'force-dynamic';

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function DocumentsPage() {
  const identity = await requireSignedIn('/portal/documents');
  const { files, reports } = await listDocuments(identity);
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  return (
    <div className="space-y-6">
      <PageHeader
        title="Documents"
        description="Released reports and the files shared with your organisation. Downloads use time-limited signed links once uploads arrive in Wave 2."
      />
      <Card>
        <CardHeader>
          <CardTitle>Released reports</CardTitle>
          <CardDescription>Only reports a named reviewer has released appear here; drafts and internal reviews are never shown.</CardDescription>
        </CardHeader>
        <CardContent>
          {reports.length === 0 ? (
            <EmptyState
              title="No released reports"
              description="Reports are produced during engagements (inspection, progress, diligence memoranda) and appear once reviewed and released."
            />
          ) : (
            <DataTable
              caption="Released reports"
              rows={reports}
              rowKey={(r) => r.id}
              rowLabel={(r) => r.title}
              columns={[
                { key: 'title', header: 'Report', cell: (r) => <span className="font-medium">{r.title}</span> },
                { key: 'kind', header: 'Kind', cell: (r) => <Badge tone="info">{humanize(r.kind)}</Badge> },
                { key: 'version', header: 'Version', cell: (r) => (r.releasedVersion ? `v${r.releasedVersion}` : '—') },
                { key: 'released', header: 'Released', cell: (r) => (r.releasedAt ? formatDateLabel(r.releasedAt, zone) : '—') },
              ]}
            />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Files</CardTitle>
          <CardDescription>Documents uploaded by you or shared by the team. Files are scanned before they become available.</CardDescription>
        </CardHeader>
        <CardContent>
          {files.length === 0 ? (
            <EmptyState
              title="No files yet"
              description="Uploads (title documents, drawings, evidence) arrive in Wave 2 with resumable uploads and malware scanning. Files the team shares with you will also be listed here."
            />
          ) : (
            <DataTable
              caption="Files"
              rows={files}
              rowKey={(f) => f.id}
              rowLabel={(f) => f.name}
              columns={[
                { key: 'name', header: 'File', cell: (f) => <span className="font-medium">{f.name}</span> },
                { key: 'purpose', header: 'Purpose', cell: (f) => humanize(f.purpose) },
                { key: 'size', header: 'Size', cell: (f) => formatBytes(f.sizeBytes), hideOnMobile: true },
                { key: 'status', header: 'Scan status', cell: (f) => <StatusBadge status={f.status} label={f.status === 'clean' ? 'Scanned clean' : humanize(f.status)} /> },
                { key: 'created', header: 'Added', cell: (f) => formatDateLabel(f.createdAt, zone) },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
