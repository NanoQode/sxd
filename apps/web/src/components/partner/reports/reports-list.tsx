'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { Page, ProjectDto, ReportDto } from '@simplexd/contracts';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  EmptyState,
  PageHeader,
  StatusBadge,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { partnerFetch, withQuery } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { useDrafts } from '@/lib/partner/offline/use-draft-store';
import { DualTime, LoadingBlock, RequestFailed } from '../common';
import { syncStateLabel, syncStateTone } from '../visits/visits-list';

export function ReportsList() {
  const p = usePartner();
  const params = useSearchParams();
  const filterProject = params.get('projectId');
  const { drafts, loading } = useDrafts(p.userId);
  const reportDrafts = drafts.filter(
    (d) => d.kind === 'report' || (d.kind === 'locked' && d.draftKind === 'report'),
  );
  const projects = useQuery({
    queryKey: ['partner', 'projects'],
    queryFn: () => partnerFetch<Page<ProjectDto>>(withQuery('/api/v1/projects', { limit: 100 })),
  });
  const projectList = (projects.data?.items ?? []).filter(
    (pr) => !filterProject || pr.id === filterProject,
  );
  const reportQueries = useQueries({
    queries: projectList.map((pr) => ({
      queryKey: ['partner', 'reports', pr.id],
      queryFn: () =>
        partnerFetch<Page<ReportDto>>(
          withQuery(`/api/v1/projects/${pr.id}/reports`, { limit: 50 }),
        ),
    })),
  });
  const rows = projectList.flatMap((pr, i) =>
    (reportQueries[i]?.data?.items ?? []).map((r) => ({ ...r, projectName: pr.name })),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Drafts you are writing for assigned projects and reports already on the server. Staff review a report before the customer can see it."
      />
      <Card>
        <CardHeader>
          <CardTitle>Drafts on this device</CardTitle>
          <p className="text-xs text-fg-muted">
            Encrypted with the session key; saved to the server only when you choose.
          </p>
        </CardHeader>
        <CardContent>
          {loading ? (
            <LoadingBlock rows={1} label="Reading drafts" />
          ) : reportDrafts.length === 0 ? (
            <p className="text-sm text-fg-muted">No report drafts on this device.</p>
          ) : (
            <ul className="space-y-2">
              {reportDrafts.map((d) => (
                <li
                  key={d.offlineClientId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
                >
                  <div>
                    <p className="flex items-center gap-2 font-medium">
                      {d.kind === 'locked' ? <Lock aria-hidden="true" className="h-4 w-4" /> : null}
                      {d.title}
                      <Badge tone={d.kind === 'locked' ? 'danger' : syncStateTone(d.syncState)}>
                        {d.kind === 'locked' ? 'Locked' : syncStateLabel(d.syncState)}
                      </Badge>
                    </p>
                    <p className="text-xs text-fg-muted">
                      Updated {formatDateTimeLabel(d.updatedAt, p.timeZone)}
                    </p>
                  </div>
                  {d.kind === 'report' ? (
                    <Link
                      href={`/partner/reports/${d.offlineClientId}`}
                      className="text-primary underline"
                    >
                      Open
                    </Link>
                  ) : (
                    <span className="text-xs text-danger">
                      Key from a previous session; discard it from the editor.
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Reports on the server</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {projects.isError ? (
            <RequestFailed
              error={projects.error}
              onRetry={() => void projects.refetch()}
              context="Projects"
            />
          ) : projects.isPending || reportQueries.some((q) => q.isPending) ? (
            <LoadingBlock label="Loading reports" />
          ) : projectList.length === 0 ? (
            <EmptyState
              title="No assigned projects"
              description="Reports belong to projects you are assigned to."
            />
          ) : (
            <>
              <DataTable
                caption="Reports"
                rows={rows}
                rowKey={(r) => r.id}
                rowLabel={(r) => r.title}
                emptyMessage="No reports on these projects yet."
                columns={[
                  {
                    key: 'title',
                    header: 'Report',
                    cell: (r) => (
                      <div>
                        <Link
                          href={`/partner/reports/${r.id}`}
                          className="font-medium text-primary underline"
                        >
                          {r.title}
                        </Link>
                        <p className="text-xs text-fg-muted">
                          {r.projectName} · {humanize(r.kind)}
                        </p>
                      </div>
                    ),
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    cell: (r) => <StatusBadge status={r.status} />,
                  },
                  { key: 'version', header: 'Version', cell: (r) => `v${r.currentVersion}` },
                  {
                    key: 'updated',
                    header: 'Updated',
                    cell: (r) => <DualTime iso={r.updatedAt} zone={p.timeZone} />,
                  },
                ]}
              />
              <div>
                <h3 className="text-sm font-medium">Start a report</h3>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {projectList.map((pr) => (
                    <li key={pr.id}>
                      <Link
                        href={`/partner/reports/new?projectId=${pr.id}`}
                        className="sx-transition inline-flex h-9 items-center rounded-md border border-border-strong px-3 text-sm hover:bg-bg-sunken"
                      >
                        {pr.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
