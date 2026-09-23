import type { Metadata } from 'next';
import Link from 'next/link';
import { leadListQuerySchema, leadStatusSchema } from '@simplexd/contracts';
import {
  Badge,
  DataTable,
  EmptyState,
  NativeSelect,
  PageHeader,
  StatusBadge,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { listLeads, listStaffAssignees } from '@/server/leads/admin';

export const metadata: Metadata = { title: 'Leads' };
export const dynamic = 'force-dynamic';

const LEAD_STATUS_TONE: Record<
  string,
  'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'
> = {
  new: 'info',
  contacted: 'primary',
  qualified: 'success',
  converted: 'success',
  closed_lost: 'neutral',
  spam: 'danger',
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    assignedToUserId?: string;
    q?: string;
    cursor?: string;
  }>;
}) {
  const identity = await requireStaffPage('leads.read');
  const raw = await searchParams;
  const query = leadListQuerySchema.parse({
    status: leadStatusSchema.safeParse(raw.status).success ? raw.status : undefined,
    assignedToUserId: raw.assignedToUserId || undefined,
    q: raw.q?.trim() || undefined,
    cursor: raw.cursor,
    limit: 25,
  });
  const [page, assignees] = await Promise.all([
    listLeads(identity, query),
    listStaffAssignees(identity),
  ]);
  const filterParams = new URLSearchParams();
  if (query.status) filterParams.set('status', query.status);
  if (query.assignedToUserId) filterParams.set('assignedToUserId', query.assignedToUserId);
  if (query.q) filterParams.set('q', query.q);
  return (
    <div className="space-y-6">
      <PageHeader
        title="CRM / Leads"
        description="Consultation requests, quote requests and map-scenario inquiries. Assign, qualify and convert into service requests."
      />
      <form
        method="get"
        className="grid gap-3 rounded-lg border border-border bg-bg-elevated p-4 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end"
      >
        <label className="text-sm">
          <span className="mb-1 block font-medium">Status</span>
          <NativeSelect name="status" defaultValue={query.status ?? ''}>
            <option value="">All statuses</option>
            {leadStatusSchema.options.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">Assignee</span>
          <NativeSelect name="assignedToUserId" defaultValue={query.assignedToUserId ?? ''}>
            <option value="">Anyone</option>
            <option value="unassigned">Unassigned</option>
            {assignees.map((a) => (
              <option key={a.userId} value={a.userId}>
                {a.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">Search</span>
          <input
            name="q"
            defaultValue={query.q ?? ''}
            placeholder="Name or email"
            className="h-11 w-full rounded-md border border-border-strong bg-bg-elevated px-3 text-sm"
          />
        </label>
        <button
          type="submit"
          className="sx-touch rounded-md border border-border-strong px-4 text-sm font-medium"
        >
          Filter
        </button>
      </form>
      {page.items.length === 0 ? (
        <EmptyState
          title="No leads match"
          description="Leads arrive from the public consultation form, quote requests and the explorer. Adjust the filters to see more."
        />
      ) : (
        <DataTable
          caption="Leads"
          rows={page.items}
          rowKey={(l) => l.id}
          rowLabel={(l) => l.contactName}
          columns={[
            {
              key: 'contact',
              header: 'Contact',
              cell: (l) => (
                <span>
                  <Link
                    href={`/admin/leads/${l.id}`}
                    className="font-medium text-primary underline"
                  >
                    {l.contactName}
                  </Link>
                  <br />
                  <span className="text-xs text-fg-muted">{l.email}</span>
                </span>
              ),
            },
            { key: 'source', header: 'Source', cell: (l) => humanize(l.source) },
            {
              key: 'service',
              header: 'Interest',
              cell: (l) => l.interestServiceName ?? (l.goal ? humanize(l.goal) : '—'),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (l) => (
                <Badge tone={LEAD_STATUS_TONE[l.status] ?? 'neutral'}>{humanize(l.status)}</Badge>
              ),
            },
            {
              key: 'assignee',
              header: 'Assignee',
              cell: (l) => l.assignedToName ?? <span className="text-fg-muted">Unassigned</span>,
            },
            { key: 'created', header: 'Received', cell: (l) => formatDateTimeLabel(l.createdAt) },
            {
              key: 'converted',
              header: 'Converted',
              cell: (l) =>
                l.convertedServiceRequestId ? (
                  <StatusBadge status="completed" label="Converted" />
                ) : (
                  '—'
                ),
              hideOnMobile: true,
            },
          ]}
        />
      )}
      {page.nextCursor ? (
        <Link
          href={`/admin/leads?${new URLSearchParams({ ...Object.fromEntries(filterParams), cursor: page.nextCursor }).toString()}`}
          className="sx-touch inline-flex items-center rounded-md border border-border-strong px-4 text-sm"
        >
          Load older leads
        </Link>
      ) : null}
    </div>
  );
}
