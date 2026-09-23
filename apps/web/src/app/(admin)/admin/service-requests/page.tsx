import type { Metadata } from 'next';
import { engagementStatusSchema } from '@simplexd/contracts';
import { PageHeader, humanize } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { can } from '@/lib/admin/server/context';
import { listRequestQueue } from '@/lib/admin/server/service-requests';
import { PRIORITY_LABELS } from '@/lib/admin/sla';
import { FilterBar, FilterCheckbox, FilterInput, FilterSelect } from '@/components/admin/filter-bar';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';
import { listStaffAssignees } from '@/server/leads/admin';
import { Pagination } from '../_components/pagination';
import { StatTile } from '../_components/bits';
import { QueueTable } from './_components/queue-table';

export const metadata: Metadata = { title: 'Service Requests' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export default async function ServiceRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireStaffPage('service_requests.read_all');
  const raw = await searchParams;
  const status = engagementStatusSchema.safeParse(raw.status).success ? raw.status : undefined;
  const priority = raw.priority && /^[1-5]$/.test(raw.priority) ? Number(raw.priority) : undefined;
  const page = Math.max(1, Number(raw.page) || 1);
  const [result, staff] = await Promise.all([
    listRequestQueue(identity, {
      status,
      priority,
      assignee: raw.assignee || undefined,
      overdueOnly: raw.overdue === '1',
      q: raw.q?.trim() || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    listStaffAssignees(identity),
  ]);
  const open = ['inquiry', 'triage', 'quoted', 'accepted', 'awaiting_payment', 'in_progress', 'in_review'].reduce(
    (s, k) => s + (result.counts[k] ?? 0),
    0,
  );
  const overdue = result.items.filter((r) => r.sla.state === 'overdue').length;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Service requests"
        description="SLA queue across every customer organisation. Overdue and due-soon requests sort first; open the request to triage, assign, quote and transition."
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Open requests" value={open} href="/admin/service-requests" />
        <StatTile label="New inquiries" value={result.counts.inquiry ?? 0} href="/admin/service-requests?status=inquiry" tone={(result.counts.inquiry ?? 0) > 0 ? 'warning' : 'neutral'} />
        <StatTile label="In triage" value={result.counts.triage ?? 0} href="/admin/service-requests?status=triage" />
        <StatTile label="Overdue on this page" value={overdue} href="/admin/service-requests?overdue=1" tone={overdue > 0 ? 'danger' : 'neutral'} hint="Filter for overdue to see every one" />
      </div>
      <SavedViewsBar tableKey="service-requests" />
      <FilterBar>
        <FilterSelect name="status" label="Status" value={status} options={engagementStatusSchema.options.map((s) => ({ value: s, label: humanize(s) }))} />
        <FilterSelect name="priority" label="Priority" value={priority ? String(priority) : undefined} options={Object.entries(PRIORITY_LABELS).map(([v, l]) => ({ value: v, label: l }))} />
        <FilterSelect
          name="assignee"
          label="Project manager"
          value={raw.assignee}
          allLabel="Anyone"
          options={[{ value: 'unassigned', label: 'Unassigned' }, ...staff.map((s) => ({ value: s.userId, label: s.name }))]}
        />
        <FilterInput name="q" label="Search" value={raw.q} placeholder="Reference or title" />
        <FilterCheckbox name="overdue" label="Overdue only" checked={raw.overdue === '1'} />
      </FilterBar>
      <QueueTable
        rows={result.items}
        staff={staff.map((s) => ({ userId: s.userId, name: s.name }))}
        canAssign={can(identity, 'service_requests.assign')}
        canTriage={can(identity, 'service_requests.triage')}
      />
      <Pagination page={page} pageSize={PAGE_SIZE} total={result.total} />
    </div>
  );
}
