import type { Metadata } from 'next';
import Link from 'next/link';
import { workOrderStatusSchema, type WorkOrderListQuery } from '@simplexd/contracts';
import { Badge, DataTable, PageHeader, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt, can } from '@/lib/admin/server/context';
import { searchOrganizations } from '@/lib/admin/server/customers';
import { listAllProperties } from '@/lib/admin/server/properties';
import { listWorkOrdersView, type WorkOrderRow } from '@/lib/admin/server/rentals';
import { summarizeSla } from '@/lib/admin/sla';
import { ExportCsvButton } from '@/components/admin/export-csv-button';
import { FilterBar, FilterCheckbox, FilterSelect } from '@/components/admin/filter-bar';
import { LoadError } from '@/components/admin/load-error';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';
import { TabLink, TabNav } from '@/components/admin/section';
import { WorkOrderCreateDialog } from '../_components/work-order-create-dialog';

export const metadata: Metadata = { title: 'Work orders' };
export const dynamic = 'force-dynamic';

const BOARD: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: 'new', label: 'New / triaged', statuses: ['requested', 'triaged'] },
  { key: 'dispatched', label: 'Assigned / in progress', statuses: ['assigned', 'in_progress'] },
  { key: 'approval', label: 'Cost approval', statuses: ['awaiting_approval', 'approved'] },
  { key: 'done', label: 'Completed → verified', statuses: ['completed', 'verified'] },
];
const PRIORITY_TONE = {
  urgent: 'danger',
  high: 'warning',
  normal: 'neutral',
  low: 'info',
} as const;

function SlaFlag({ w }: { w: WorkOrderRow }) {
  if (w.slaBreached) return <Badge tone="danger">SLA breached</Badge>;
  const s = summarizeSla(
    w.slaDueAt,
    ['completed', 'verified', 'closed', 'rejected', 'cancelled'].includes(w.status)
      ? 'completed'
      : w.status,
  );
  if (s.state === 'due_soon') return <Badge tone="warning">{s.label}</Badge>;
  if (s.state === 'overdue') return <Badge tone="danger">{s.label}</Badge>;
  if (s.state === 'ok') return <Badge tone="success">{s.label}</Badge>;
  return null;
}

function Card({ w }: { w: WorkOrderRow }) {
  return (
    <li
      className={`rounded-md border p-2 text-sm ${w.slaBreached ? 'border-danger/60' : 'border-border'} bg-bg-elevated`}
    >
      <Link
        href={`/admin/rentals/work-orders/${w.id}`}
        className="font-medium text-primary underline"
      >
        {w.title}
      </Link>
      <p className="text-xs text-fg-muted">
        {w.propertyName ?? 'property'}
        {w.unitLabel ? ` · ${w.unitLabel}` : ''} · {humanize(w.category)}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Badge tone={PRIORITY_TONE[w.priority]}>{w.priority}</Badge>
        <Badge>{humanize(w.status)}</Badge>
        <SlaFlag w={w} />
      </div>
      <p className="mt-1 text-xs text-fg-muted">
        {w.assigneeName ? `Assigned to ${w.assigneeName}` : 'Unassigned'}
      </p>
    </li>
  );
}

export default async function WorkOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireSignedIn('/admin/rentals/work-orders');
  const raw = await searchParams;
  const view = raw.view === 'list' ? 'list' : 'board';
  const status = workOrderStatusSchema.safeParse(raw.status).success
    ? (raw.status as WorkOrderListQuery['status'])
    : undefined;
  const [loaded, orgs, props] = await Promise.all([
    attempt(() =>
      listWorkOrdersView(identity, {
        status,
        organizationId: raw.organizationId || undefined,
        breachedOnly: raw.breached === '1' ? true : undefined,
        cursor: raw.cursor || undefined,
        limit: 100,
      }),
    ),
    attempt(() => searchOrganizations(identity, undefined, 500)),
    attempt(() => listAllProperties(identity, { status: 'active' })),
  ]);
  if (!loaded.ok)
    return <LoadError code={loaded.code} message={loaded.message} what="Work orders" />;
  const rows = loaded.value.items;
  const q = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...raw, cursor: undefined, ...patch }))
      if (v) p.set(k, v);
    return `/admin/rentals/work-orders${p.size ? `?${p.toString()}` : ''}`;
  };
  const canCreate = can(identity, 'maintenance.manage') || can(identity, 'rentals.manage');
  return (
    <div className="space-y-6">
      <PageHeader
        title="Work orders"
        description="Maintenance from owners, tenants and staff. The SLA deadline follows the priority (urgent 4 h, high 24 h, normal 72 h, low 7 days); breached work is flagged by the SLA job. Owners approve costs; verification posts the recoverable expense."
        actions={
          canCreate && props.ok ? (
            <WorkOrderCreateDialog
              properties={props.value.items.map((p) => ({ id: p.id, name: p.name }))}
            />
          ) : undefined
        }
      />
      <TabNav label="Work order views">
        <TabLink href={q({ view: undefined })} active={view === 'board'}>
          Board
        </TabLink>
        <TabLink href={q({ view: 'list' })} active={view === 'list'}>
          List
        </TabLink>
      </TabNav>
      <SavedViewsBar tableKey="rentals-work-orders" />
      <FilterBar hidden={{ view: raw.view }}>
        <FilterSelect
          name="status"
          label="Status"
          value={status}
          options={workOrderStatusSchema.options.map((s) => ({ value: s, label: humanize(s) }))}
        />
        <FilterSelect
          name="organizationId"
          label="Owner organisation"
          value={raw.organizationId}
          allLabel="All"
          options={(orgs.ok ? orgs.value : []).map((o) => ({ value: o.id, label: o.name }))}
        />
        <FilterCheckbox name="breached" label="SLA breached only" checked={raw.breached === '1'} />
      </FilterBar>
      {view === 'board' ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {BOARD.map((col) => {
            const items = rows.filter((w) => col.statuses.includes(w.status));
            return (
              <section
                key={col.key}
                aria-label={col.label}
                className="rounded-lg border border-border bg-bg-sunken/50 p-2"
              >
                <h2 className="mb-2 flex items-center justify-between text-sm font-medium">
                  {col.label} <Badge>{items.length}</Badge>
                </h2>
                {items.length === 0 ? <p className="text-xs text-fg-subtle">Nothing here</p> : null}
                <ul className="space-y-2">
                  {items.map((w) => (
                    <Card key={w.id} w={w} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : (
        <>
          <div className="flex justify-end">
            <ExportCsvButton
              rows={rows}
              filename="work-orders.csv"
              columns={[
                { header: 'Id', value: (w) => w.id },
                { header: 'Title', value: (w) => w.title },
                { header: 'Property', value: (w) => w.propertyName },
                { header: 'Owner', value: (w) => w.organizationName },
                { header: 'Priority', value: (w) => w.priority },
                { header: 'Status', value: (w) => w.status },
                { header: 'SLA due', value: (w) => w.slaDueAt },
                { header: 'SLA breached', value: (w) => w.slaBreached },
                { header: 'Assignee', value: (w) => w.assigneeName },
                { header: 'Approved kobo', value: (w) => w.approvedAmountKobo },
                { header: 'Actual cost kobo', value: (w) => w.actualCostKobo },
              ]}
            />
          </div>
          <DataTable
            caption="Work orders"
            rows={rows}
            rowKey={(w) => w.id}
            rowLabel={(w) => w.title}
            emptyMessage="No work orders in this view."
            columns={[
              {
                key: 't',
                header: 'Work order',
                cell: (w) => (
                  <span>
                    <Link
                      href={`/admin/rentals/work-orders/${w.id}`}
                      className="font-medium text-primary underline"
                    >
                      {w.title}
                    </Link>
                    <span className="block text-xs text-fg-muted">
                      {w.propertyName ?? ''} · {w.organizationName}
                    </span>
                  </span>
                ),
              },
              {
                key: 'p',
                header: 'Priority',
                cell: (w) => <Badge tone={PRIORITY_TONE[w.priority]}>{w.priority}</Badge>,
              },
              { key: 's', header: 'Status', cell: (w) => humanize(w.status) },
              {
                key: 'sla',
                header: 'SLA',
                cell: (w) => (
                  <span>
                    <SlaFlag w={w} />
                    <span className="block text-xs text-fg-muted">
                      {w.slaDueAt ? formatDateTimeLabel(w.slaDueAt) : '—'}
                    </span>
                  </span>
                ),
              },
              {
                key: 'a',
                header: 'Assignee',
                cell: (w) => w.assigneeName ?? '—',
                hideOnMobile: true,
              },
              {
                key: 'c',
                header: 'Raised',
                cell: (w) => formatDateTimeLabel(w.createdAt),
                hideOnMobile: true,
              },
            ]}
          />
        </>
      )}
      {rows.some((w) => ['closed', 'rejected', 'cancelled'].includes(w.status)) &&
      view === 'board' ? (
        <p className="text-xs text-fg-muted">
          {rows.filter((w) => ['closed', 'rejected', 'cancelled'].includes(w.status)).length}{' '}
          closed, rejected or cancelled work orders are in the{' '}
          <Link href={q({ view: 'list' })} className="underline">
            list view
          </Link>
          .
        </p>
      ) : null}
      {loaded.value.nextCursor ? (
        <Link
          href={`${q({})}${q({}).includes('?') ? '&' : '?'}cursor=${encodeURIComponent(loaded.value.nextCursor)}`}
          className="text-sm underline"
        >
          More
        </Link>
      ) : null}
    </div>
  );
}
