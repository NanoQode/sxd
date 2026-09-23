import { Badge, DataTable, formatDateTimeLabel, humanize } from '@simplexd/ui';
import type { RequestIdentity } from '@/lib/auth/session';
import type { ProjectShell } from '@/lib/admin/server/projects';
import { listEvidence } from '@/server/projects/evidence';
import { ApiAction } from '@/components/admin/api-action';
import { Section } from '@/components/admin/section';

export async function EvidenceTab({ identity, shell }: { identity: RequestIdentity; shell: ProjectShell }) {
  const p = shell.overview.project;
  const { items } = await listEvidence(identity, p.id, { limit: 100 });
  const canApprove = shell.permissions.evidenceApprove;
  return (
    <Section
      title={`Evidence (${items.length})`}
      description="Capture time, uploader, checksum and GPS are user-provided metadata stored separately from server receipt time; they are not proof of authenticity. Only approved evidence is visible to the customer; redacted public derivatives need a separate file."
    >
      <DataTable
        caption="Evidence"
        rows={items}
        rowKey={(e) => e.id}
        rowLabel={(e) => e.caption ?? e.file?.originalName ?? e.id}
        emptyMessage="No evidence linked yet. Inspectors upload from site visits; staff link scanned files through the evidence API."
        columns={[
          {
            key: 'file',
            header: 'File',
            cell: (e) => (
              <span>
                <a href={`/api/v1/files/${e.fileId}/download`} className="font-medium underline">
                  {e.file?.originalName ?? e.fileId.slice(0, 8)}
                </a>
                <span className="block text-xs text-fg-muted">
                  {humanize(e.kind)} · {e.file?.declaredMime ?? 'unknown type'} · {e.file?.status ?? 'unknown scan state'}
                </span>
                {e.caption ? <span className="block text-xs">{e.caption}</span> : null}
              </span>
            ),
          },
          { key: 'captured', header: 'Captured (device)', cell: (e) => (e.capturedAt ? formatDateTimeLabel(e.capturedAt) : <span className="text-fg-muted">not provided</span>) },
          { key: 'received', header: 'Received (server)', cell: (e) => formatDateTimeLabel(e.receivedAt), hideOnMobile: true },
          { key: 'gps', header: 'GPS', cell: (e) => (e.captureGps ? `${e.captureGps.lat.toFixed(4)}, ${e.captureGps.lon.toFixed(4)}` : '—'), hideOnMobile: true },
          { key: 'links', header: 'Linked to', cell: (e) => [e.siteVisitId ? 'visit' : null, e.reportId ? 'report' : null, e.defectId ? 'defect' : null].filter(Boolean).join(', ') || '—', hideOnMobile: true },
          {
            key: 'publication',
            header: 'Publication',
            cell: (e) => (
              <span className="flex flex-wrap items-center gap-1">
                <Badge tone={e.publication === 'approved' ? 'success' : e.publication === 'redacted_public' ? 'info' : 'neutral'}>{humanize(e.publication)}</Badge>
                {canApprove && e.publication !== 'approved' ? (
                  <ApiAction path={`/api/v1/projects/${p.id}/evidence/${e.id}/publication`} label="Approve for customer" body={{ publication: 'approved' }} successMessage="Evidence approved" />
                ) : null}
                {canApprove && e.publication !== 'restricted' ? (
                  <ApiAction path={`/api/v1/projects/${p.id}/evidence/${e.id}/publication`} label="Restrict" variant="ghost" body={{ publication: 'restricted' }} confirm={{ title: 'Restrict this evidence?', description: 'The customer loses access to it immediately.', confirmLabel: 'Restrict', tone: 'danger' }} successMessage="Evidence restricted" />
                ) : null}
              </span>
            ),
          },
        ]}
      />
      <p className="text-xs text-fg-muted">Checksums (SHA-256) are stored with each record; compare with the original when authenticity is questioned.</p>
    </Section>
  );
}
