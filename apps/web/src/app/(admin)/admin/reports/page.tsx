import type { Metadata } from 'next';
import Link from 'next/link';
import { reportStatusSchema } from '@simplexd/contracts';
import {
  Badge,
  DataTable,
  EmptyState,
  PageHeader,
  StatusBadge,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { listReportQueue } from '@/lib/admin/server/reports';
import { FilterBar, FilterCheckbox, FilterSelect } from '@/components/admin/filter-bar';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';
import { Pagination } from '../_components/pagination';
import { StatTile } from '../_components/bits';

export const metadata: Metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireSignedIn('/admin/reports');
  const raw = await searchParams;
  const status = reportStatusSchema.safeParse(raw.status).success ? raw.status : undefined;
  const page = Math.max(1, Number(raw.page) || 1);
  const result = await listReportQueue(identity, {
    status,
    mineOnly: raw.mine === '1',
    page,
    pageSize: PAGE_SIZE,
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Review queue across projects. A report is submitted to a named reviewer who is not its author; only approved reports can be released, and only by someone other than the author."
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="In review"
          value={result.counts.in_review ?? 0}
          href="/admin/reports?status=in_review"
          tone={(result.counts.in_review ?? 0) > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Changes requested"
          value={result.counts.changes_requested ?? 0}
          href="/admin/reports?status=changes_requested"
        />
        <StatTile
          label="Approved, not released"
          value={result.counts.approved ?? 0}
          href="/admin/reports?status=approved"
          tone={(result.counts.approved ?? 0) > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Released"
          value={result.counts.released ?? 0}
          href="/admin/reports?status=released"
        />
      </div>
      <SavedViewsBar tableKey="reports" />
      <FilterBar>
        <FilterSelect
          name="status"
          label="Status"
          value={status}
          allLabel="Open (not released)"
          options={reportStatusSchema.options.map((s) => ({ value: s, label: humanize(s) }))}
        />
        <FilterCheckbox name="mine" label="Only reports I review" checked={raw.mine === '1'} />
      </FilterBar>
      {result.items.length === 0 ? (
        <EmptyState
          title="No reports in this view"
          description="Reports are drafted from a project's Reports tab or by inspectors after a site visit."
        />
      ) : (
        <DataTable
          caption="Report review queue"
          rows={result.items}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.title}
          columns={[
            {
              key: 'title',
              header: 'Report',
              cell: (r) => (
                <span>
                  <Link
                    href={`/admin/reports/${r.id}`}
                    className="font-medium text-primary underline"
                  >
                    {r.title}
                  </Link>
                  <span className="block text-xs text-fg-muted">
                    {humanize(r.kind)} · v{r.currentVersion}
                  </span>
                </span>
              ),
            },
            {
              key: 'project',
              header: 'Project',
              cell: (r) =>
                r.projectId ? (
                  <Link href={`/admin/projects/${r.projectId}?tab=reports`} className="underline">
                    {r.projectName ?? 'project'}
                  </Link>
                ) : r.serviceRequestId ? (
                  <Link
                    href={`/admin/service-requests/${r.serviceRequestId}`}
                    className="underline"
                  >
                    request
                  </Link>
                ) : (
                  '—'
                ),
            },
            {
              key: 'org',
              header: 'Organisation',
              cell: (r) => r.organizationName,
              hideOnMobile: true,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (r) => (
                <StatusBadge
                  status={
                    r.status === 'released'
                      ? 'delivered'
                      : r.status === 'approved'
                        ? 'accepted'
                        : r.status === 'changes_requested'
                          ? 'paused'
                          : r.status
                  }
                  label={humanize(r.status)}
                />
              ),
            },
            { key: 'author', header: 'Author', cell: (r) => r.authorName ?? '—' },
            {
              key: 'reviewer',
              header: 'Named reviewer',
              cell: (r) =>
                r.namedReviewerName ? (
                  <span>
                    {r.namedReviewerName} {r.isMyReview ? <Badge tone="primary">you</Badge> : null}
                  </span>
                ) : (
                  <span className="text-fg-muted">not yet named</span>
                ),
            },
            {
              key: 'updated',
              header: 'Updated',
              cell: (r) => formatDateTimeLabel(r.updatedAt),
              hideOnMobile: true,
            },
          ]}
        />
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} total={result.total} />
    </div>
  );
}
