import type { Metadata } from 'next';
import Link from 'next/link';
import { assignmentStatusSchema } from '@simplexd/contracts';
import { Badge, DataTable, PageHeader, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { calendarEntries, workloadView } from '@/lib/admin/server/workload';
import { ApiAction } from '@/components/admin/api-action';
import { ExportCsvButton } from '@/components/admin/export-csv-button';
import { FilterBar, FilterSelect } from '@/components/admin/filter-bar';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';
import { Section, TabLink, TabNav } from '@/components/admin/section';
import { Pagination } from '../_components/pagination';
import { WeekCalendar } from './_components/week-calendar';

export const metadata: Metadata = { title: 'Assignments' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

function startOfWeek(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - day);
  return x;
}

export default async function AssignmentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const identity = await requireSignedIn('/admin/assignments');
  const raw = await searchParams;
  const view = raw.view === 'calendar' ? 'calendar' : raw.view === 'list' ? 'list' : 'workload';
  const page = Math.max(1, Number(raw.page) || 1);
  const status = assignmentStatusSchema.safeParse(raw.status).success ? raw.status : undefined;
  const data = await workloadView(identity, { status, assignee: raw.assignee || undefined, page, pageSize: PAGE_SIZE });
  const weekStart = startOfWeek(raw.week ? new Date(raw.week) : new Date());
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
  const entries = view === 'calendar' ? await calendarEntries(identity, { from: weekStart, to: weekEnd, staffUserId: raw.assignee || undefined }) : [];
  const q = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...raw, ...patch })) if (v) params.set(k, v);
    return `/admin/assignments?${params.toString()}`;
  };
  return (
    <div className="space-y-6">
      <PageHeader
        title="Assignments"
        description="Who is carrying what: assignment counts by status per staff member and partner, project-manager load, and the week's visits and appointments. Propose assignments from a request or project page."
      />
      <TabNav label="Assignment views">
        <TabLink href={q({ view: undefined })} active={view === 'workload'}>
          Workload
        </TabLink>
        <TabLink href={q({ view: 'list' })} active={view === 'list'}>
          All assignments
        </TabLink>
        <TabLink href={q({ view: 'calendar' })} active={view === 'calendar'}>
          Calendar
        </TabLink>
      </TabNav>
      <SavedViewsBar tableKey="assignments" />
      <FilterBar hidden={{ view: raw.view }}>
        <FilterSelect name="assignee" label="Person" value={raw.assignee} allLabel="Everyone" options={data.workload.map((w) => ({ value: w.userId, label: `${w.name} (${w.kind})` }))} />
        {view === 'list' ? <FilterSelect name="status" label="Status" value={status} options={assignmentStatusSchema.options.map((s) => ({ value: s, label: humanize(s) }))} /> : null}
        {view === 'calendar' ? (
          <label className="text-sm">
            <span className="mb-1 block font-medium">Week of</span>
            <input type="date" name="week" defaultValue={weekStart.toISOString().slice(0, 10)} className="h-11 w-full rounded-md border border-border-strong bg-bg-elevated px-3 text-sm" />
          </label>
        ) : null}
      </FilterBar>

      {view === 'workload' ? (
        <Section
          title="Workload"
          description="Active = proposed + accepted + active assignments. PM load counts open requests where the person is project manager."
          actions={
            <ExportCsvButton
              rows={data.workload}
              filename="workload.csv"
              columns={[
                { header: 'Name', value: (w) => w.name },
                { header: 'Kind', value: (w) => w.kind },
                { header: 'Roles', value: (w) => w.roles.join('|') },
                { header: 'Active assignments', value: (w) => w.activeTotal },
                { header: 'Completed', value: (w) => w.assignments.completed ?? 0 },
                { header: 'PM requests', value: (w) => w.pmRequests },
                { header: 'Visits next 7d', value: (w) => w.upcomingVisits },
                { header: 'Appointments next 7d', value: (w) => w.upcomingAppointments },
              ]}
            />
          }
        >
          <DataTable
            caption="Workload per person"
            rows={data.workload.filter((w) => !raw.assignee || w.userId === raw.assignee)}
            rowKey={(w) => w.userId}
            rowLabel={(w) => w.name}
            columns={[
              {
                key: 'name',
                header: 'Person',
                cell: (w) => (
                  <span>
                    <Link href={q({ view: 'list', assignee: w.userId })} className="font-medium underline">
                      {w.name}
                    </Link>
                    <span className="block text-xs text-fg-muted">
                      {w.kind === 'staff' ? w.roles.map(humanize).join(', ') : `${humanize(w.partnerType ?? 'partner')} · ${humanize(w.verificationStatus ?? 'unverified')}`}
                    </span>
                  </span>
                ),
              },
              { key: 'active', header: 'Active', cell: (w) => <Badge tone={w.activeTotal > 5 ? 'warning' : 'neutral'}>{w.activeTotal}</Badge> },
              { key: 'proposed', header: 'Proposed', cell: (w) => w.assignments.proposed ?? 0, hideOnMobile: true },
              { key: 'completed', header: 'Completed', cell: (w) => w.assignments.completed ?? 0, hideOnMobile: true },
              { key: 'declined', header: 'Declined / revoked', cell: (w) => `${w.assignments.declined ?? 0} / ${w.assignments.revoked ?? 0}`, hideOnMobile: true },
              { key: 'pm', header: 'PM requests', cell: (w) => w.pmRequests },
              { key: 'visits', header: 'Visits (7d)', cell: (w) => w.upcomingVisits },
              { key: 'appts', header: 'Appointments (7d)', cell: (w) => w.upcomingAppointments },
            ]}
          />
        </Section>
      ) : null}

      {view === 'list' ? (
        <Section title={`Assignments (${data.total})`}>
          <DataTable
            caption="Assignments"
            rows={data.assignments}
            rowKey={(a) => a.id}
            rowLabel={(a) => `${a.assigneeName ?? a.assigneeUserId} ${a.role}`}
            emptyMessage="No assignments match."
            columns={[
              { key: 'target', header: 'Work', cell: (a) => <Link href={a.serviceRequestId ? `/admin/service-requests/${a.serviceRequestId}` : `/admin/projects/${a.projectId}`} className="underline">{a.targetLabel}</Link> },
              { key: 'org', header: 'Organisation', cell: (a) => a.organizationName, hideOnMobile: true },
              { key: 'who', header: 'Assignee', cell: (a) => `${a.assigneeName ?? a.assigneeUserId} · ${humanize(a.role)}` },
              { key: 'status', header: 'Status', cell: (a) => <StatusBadge status={a.status === 'active' ? 'in_progress' : a.status === 'proposed' ? 'pending' : a.status} label={humanize(a.status)} /> },
              { key: 'when', header: 'Window', cell: (a) => `${a.startsAt ? formatDateTimeLabel(a.startsAt) : '—'} → ${a.endsAt ? formatDateTimeLabel(a.endsAt) : '—'}`, hideOnMobile: true },
              {
                key: 'actions',
                header: 'Actions',
                cell: (a) =>
                  data.canAssign ? (
                    <span className="flex flex-wrap gap-1">
                      {a.status === 'accepted' ? <ApiAction path={`/api/v1/assignments/${a.id}/activate`} label="Activate" successMessage="Activated" /> : null}
                      {a.status === 'active' ? <ApiAction path={`/api/v1/assignments/${a.id}/complete`} label="Complete" successMessage="Completed" /> : null}
                      {['proposed', 'accepted', 'active'].includes(a.status) ? (
                        <ApiAction path={`/api/v1/assignments/${a.id}/revoke`} label="Revoke" variant="ghost" body={(reason) => ({ reason })} confirm={{ title: 'Revoke assignment?', requireReason: true, confirmLabel: 'Revoke', tone: 'danger' }} successMessage="Revoked" />
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-xs text-fg-muted">read-only</span>
                  ),
              },
            ]}
          />
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} />
        </Section>
      ) : null}

      {view === 'calendar' ? (
        <Section
          title={`Week of ${weekStart.toISOString().slice(0, 10)}`}
          description="Appointments and scheduled site visits. Times are shown in Africa/Lagos."
          actions={
            <>
              <Link href={q({ view: 'calendar', week: new Date(weekStart.getTime() - 7 * 86_400_000).toISOString().slice(0, 10) })} className="text-sm underline">
                Previous week
              </Link>
              <Link href={q({ view: 'calendar', week: new Date(weekStart.getTime() + 7 * 86_400_000).toISOString().slice(0, 10) })} className="text-sm underline">
                Next week
              </Link>
            </>
          }
        >
          <WeekCalendar weekStartIso={weekStart.toISOString()} entries={entries} />
        </Section>
      ) : null}
    </div>
  );
}
