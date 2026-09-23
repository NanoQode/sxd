import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, DataTable, EmptyState, PageHeader, StatusBadge, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { listProjects } from '@/server/portal/lists';

export const metadata: Metadata = { title: 'Projects' };
export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const identity = await requireSignedIn('/portal/projects');
  const projects = await listProjects(identity);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        description="Monitored builds, designs and renovations with schedules, budgets, reports, defects and the decisions waiting on you."
      />
      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="A project is opened by the team once a construction monitoring, architecture, renovation or snagging engagement is accepted and paid where required. Approvals, budget changes and site visits then appear here."
          action={
            <Link href="/portal/requests/new" className="sx-touch inline-flex items-center rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary">
              Request a service
            </Link>
          }
        />
      ) : (
        <DataTable
          caption="Projects"
          rows={projects}
          rowKey={(p) => p.id}
          rowLabel={(p) => p.name}
          columns={[
            { key: 'name', header: 'Project', cell: (p) => <span className="font-medium">{p.name}</span> },
            { key: 'kind', header: 'Kind', cell: (p) => humanize(p.kind) },
            { key: 'status', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
            { key: 'target', header: 'Target completion', cell: (p) => p.forecastCompletionDate ?? p.targetCompletionDate ?? '—' },
            { key: 'pm', header: 'Project manager', cell: (p) => p.pmName ?? 'Not assigned', hideOnMobile: true },
            {
              key: 'approvals',
              header: 'Needs you',
              cell: (p) => (p.pendingApprovals > 0 ? <Badge tone="warning">{p.pendingApprovals} approval(s)</Badge> : <span className="text-fg-muted">Nothing pending</span>),
            },
          ]}
        />
      )}
    </div>
  );
}
