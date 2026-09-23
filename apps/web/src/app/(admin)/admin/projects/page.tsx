import type { Metadata } from 'next';
import Link from 'next/link';
import { projectKindSchema, projectStatusSchema } from '@simplexd/contracts';
import {
  DataTable,
  EmptyState,
  PageHeader,
  StatusBadge,
  formatDateLabel,
  humanize,
} from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { can, orgNames, staffTx } from '@/lib/admin/server/context';
import { searchOrganizations } from '@/lib/admin/server/customers';
import { listStaffAssignees } from '@/server/leads/admin';
import { listProjects } from '@/server/projects/projects';
import { FilterBar, FilterInput, FilterSelect } from '@/components/admin/filter-bar';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';
import { CreateProjectDialog } from './_components/create-project-dialog';

export const metadata: Metadata = { title: 'Projects' };
export const dynamic = 'force-dynamic';

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireStaffPage('projects.read_all');
  const raw = await searchParams;
  const status = projectStatusSchema.safeParse(raw.status).success
    ? (raw.status as never)
    : undefined;
  const kind = projectKindSchema.safeParse(raw.kind).success ? (raw.kind as never) : undefined;
  const canManage = can(identity, 'projects.manage');
  const [page, orgs, staff] = await Promise.all([
    listProjects(identity, {
      status,
      kind,
      organizationId: raw.organizationId || undefined,
      q: raw.q?.trim() || undefined,
      cursor: raw.cursor,
      limit: 50,
    }),
    searchOrganizations(identity, undefined, 200),
    canManage ? listStaffAssignees(identity) : Promise.resolve([]),
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
        title="Projects"
        description="Delivery engine: baselines, budgets and BOQ, schedules, milestones, site visits, reports, evidence, defects, change orders, permits and design options."
        actions={
          canManage ? (
            <CreateProjectDialog
              organizations={orgs}
              staff={staff.map((s) => ({ userId: s.userId, name: s.name }))}
              prefill={{
                open: raw.create === '1',
                organizationId: raw.organizationId,
                serviceRequestId: raw.serviceRequestId,
                name: raw.name,
              }}
            />
          ) : null
        }
      />
      <SavedViewsBar tableKey="projects" />
      <FilterBar>
        <FilterSelect
          name="status"
          label="Status"
          value={status}
          options={projectStatusSchema.options.map((s) => ({ value: s, label: humanize(s) }))}
        />
        <FilterSelect
          name="kind"
          label="Kind"
          value={kind}
          options={projectKindSchema.options.map((k) => ({ value: k, label: humanize(k) }))}
        />
        <FilterSelect
          name="organizationId"
          label="Organisation"
          value={raw.organizationId}
          allLabel="All"
          options={orgs.map((o) => ({ value: o.id, label: o.name }))}
        />
        <FilterInput name="q" label="Search" value={raw.q} placeholder="Project name" />
      </FilterBar>
      {page.items.length === 0 ? (
        <EmptyState
          title="No projects match"
          description="Create a project from an accepted service request, or directly for a customer organisation."
        />
      ) : (
        <DataTable
          caption="Projects"
          rows={page.items}
          rowKey={(p) => p.id}
          rowLabel={(p) => p.name}
          columns={[
            {
              key: 'name',
              header: 'Project',
              cell: (p) => (
                <Link
                  href={`/admin/projects/${p.id}`}
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
              key: 'status',
              header: 'Status',
              cell: (p) => (
                <StatusBadge
                  status={
                    p.status === 'active'
                      ? 'in_progress'
                      : p.status === 'planning'
                        ? 'draft'
                        : p.status
                  }
                  label={humanize(p.status)}
                />
              ),
            },
            {
              key: 'dates',
              header: 'Start → target',
              cell: (p) =>
                `${p.startDate ? formatDateLabel(p.startDate) : '—'} → ${p.targetCompletionDate ? formatDateLabel(p.targetCompletionDate) : '—'}`,
              hideOnMobile: true,
            },
            {
              key: 'forecast',
              header: 'Forecast',
              cell: (p) =>
                p.forecastCompletionDate ? (
                  formatDateLabel(p.forecastCompletionDate)
                ) : (
                  <span className="text-fg-muted">unknown</span>
                ),
              hideOnMobile: true,
            },
            {
              key: 'budget',
              header: 'Budget',
              cell: (p) =>
                p.approvedBudgetVersionId ? (
                  'approved'
                ) : (
                  <span className="text-fg-muted">none approved</span>
                ),
            },
          ]}
        />
      )}
      {page.nextCursor ? (
        <Link
          href={`/admin/projects?${new URLSearchParams({ ...(Object.fromEntries(Object.entries(raw).filter(([, v]) => v)) as Record<string, string>), cursor: page.nextCursor }).toString()}`}
          className="sx-touch inline-flex items-center rounded-md border border-border-strong px-4 text-sm"
        >
          Load more
        </Link>
      ) : null}
    </div>
  );
}
