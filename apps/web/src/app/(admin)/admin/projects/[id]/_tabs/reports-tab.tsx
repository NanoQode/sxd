import Link from 'next/link';
import { reportKindSchema } from '@simplexd/contracts';
import { DataTable, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import type { RequestIdentity } from '@/lib/auth/session';
import type { ProjectShell } from '@/lib/admin/server/projects';
import { listReports } from '@/server/projects/reports';
import { FormDialog } from '@/components/admin/form-dialog';
import { Section } from '@/components/admin/section';

export async function ReportsTab({ identity, shell }: { identity: RequestIdentity; shell: ProjectShell }) {
  const p = shell.overview.project;
  const { items } = await listReports(identity, p.id, { limit: 100 });
  return (
    <Section
      title={`Reports (${items.length})`}
      description="Versioned deliverables: draft → submit to a named reviewer (not the author) → approve or request changes → release. Customers only ever see released revisions."
      actions={
        shell.permissions.reportsDraft ? (
          <FormDialog
            trigger="Draft report"
            title="Draft a report"
            path={`/api/v1/projects/${p.id}/reports`}
            successMessage="Report drafted"
            redirectTo="/admin/reports/{id}"
            fields={[
              { name: 'kind', label: 'Kind', type: 'select', required: true, options: reportKindSchema.options.map((k) => ({ value: k, label: humanize(k) })) },
              { name: 'title', label: 'Title', required: true },
              { name: 'summary', label: 'Summary', type: 'textarea', bodyKey: 'initialRevision.summary', emptyAs: 'null' },
              { name: 'bodyMarkdown', label: 'Body (markdown)', type: 'textarea', required: true, bodyKey: 'initialRevision.bodyMarkdown' },
              { name: 'scopeLimitations', label: 'Scope and limitations', type: 'textarea', hint: 'What this report does not cover. Never implies a legal guarantee.', bodyKey: 'initialRevision.scopeLimitations', emptyAs: 'null' },
            ]}
            extraBody={{ serviceRequestId: p.serviceRequestId, 'initialRevision.attachmentFileIds': [] }}
          />
        ) : null
      }
    >
      <DataTable
        caption="Reports"
        rows={items}
        rowKey={(r) => r.id}
        rowLabel={(r) => r.title}
        emptyMessage="No reports drafted for this project."
        columns={[
          { key: 'title', header: 'Report', cell: (r) => <Link href={`/admin/reports/${r.id}`} className="font-medium text-primary underline">{r.title}</Link> },
          { key: 'kind', header: 'Kind', cell: (r) => humanize(r.kind) },
          { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status === 'released' ? 'delivered' : r.status === 'approved' ? 'accepted' : r.status === 'changes_requested' ? 'paused' : r.status} label={humanize(r.status)} /> },
          { key: 'version', header: 'Version', cell: (r) => `v${r.currentVersion}${r.releasedVersion ? ` (released v${r.releasedVersion})` : ''}` },
          { key: 'people', header: 'Author / reviewer', cell: (r) => `${r.authorName ?? '—'} / ${r.namedReviewerName ?? '—'}`, hideOnMobile: true },
          { key: 'updated', header: 'Updated', cell: (r) => formatDateTimeLabel(r.updatedAt), hideOnMobile: true },
        ]}
      />
    </Section>
  );
}
