'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  Badge,
  DataTable,
  EmptyState,
  Field,
  NativeSelect,
  StatusBadge,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { adminFetch } from '@/lib/admin/client';
import type { QueueRow } from '@/lib/admin/server/service-requests';
import { priorityLabel } from '@/lib/admin/sla';
import { BulkActionBar, type BulkAction } from '@/components/admin/bulk-action-bar';
import { ExportCsvButton } from '@/components/admin/export-csv-button';

const SLA_TONE: Record<QueueRow['sla']['state'], 'neutral' | 'success' | 'warning' | 'danger'> = {
  none: 'neutral',
  ok: 'success',
  due_soon: 'warning',
  overdue: 'danger',
  stopped: 'neutral',
};

const PRIORITY_TONE: Record<number, 'danger' | 'warning' | 'neutral' | 'info'> = {
  1: 'danger',
  2: 'warning',
  3: 'neutral',
  4: 'info',
  5: 'info',
};

export function QueueTable({
  rows,
  staff,
  canAssign,
  canTriage,
}: {
  rows: QueueRow[];
  staff: Array<{ userId: string; name: string }>;
  canAssign: boolean;
  canTriage: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPm, setBulkPm] = useState('');
  const [bulkPriority, setBulkPriority] = useState('3');

  const selectedItems = useMemo(
    () =>
      rows
        .filter((r) => selected.has(r.id))
        .map((r) => ({ id: r.id, label: `${r.reference} · ${r.title}` })),
    [rows, selected],
  );
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const actions: BulkAction[] = [];
  if (canTriage) {
    actions.push({
      key: 'triage',
      label: 'Triage and assign PM',
      description:
        'Moves each new inquiry into triage with the chosen project manager and priority. Requests already past inquiry are skipped.',
      ready: Boolean(bulkPm),
      eligible: (item) =>
        byId.get(item.id)?.status === 'inquiry' ? null : 'only inquiries can be triaged',
      form: (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Project manager" required>
            {({ id }) => (
              <NativeSelect id={id} value={bulkPm} onChange={(e) => setBulkPm(e.target.value)}>
                <option value="">Choose</option>
                {staff.map((s) => (
                  <option key={s.userId} value={s.userId}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="Priority">
            {({ id }) => (
              <NativeSelect
                id={id}
                value={bulkPriority}
                onChange={(e) => setBulkPriority(e.target.value)}
              >
                {[1, 2, 3, 4, 5].map((p) => (
                  <option key={p} value={p}>
                    {priorityLabel(p)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        </div>
      ),
      run: async (item, reason) => {
        const row = byId.get(item.id)!;
        const res = await adminFetch<{ slaDueAt: string | null }>(
          `/api/v1/service-requests/${item.id}/triage`,
          {
            body: {
              assignedPmUserId: bulkPm,
              priority: Number(bulkPriority),
              note: reason || undefined,
              expectedVersion: row.version,
            },
          },
        );
        return res.slaDueAt
          ? `triaged; SLA due ${formatDateTimeLabel(res.slaDueAt)}`
          : 'triaged; no SLA policy for this service';
      },
    });
  }
  if (canAssign) {
    actions.push({
      key: 'assign',
      label: 'Reassign PM',
      description:
        'Changes the project manager on requests that are already triaged. New inquiries are skipped (triage them first).',
      ready: Boolean(bulkPm),
      eligible: (item) =>
        byId.get(item.id)?.status === 'inquiry' ? 'still an inquiry; use triage' : null,
      form: (
        <Field label="Project manager" required>
          {({ id }) => (
            <NativeSelect id={id} value={bulkPm} onChange={(e) => setBulkPm(e.target.value)}>
              <option value="">Choose</option>
              {staff.map((s) => (
                <option key={s.userId} value={s.userId}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      ),
      run: async (item, reason) => {
        const row = byId.get(item.id)!;
        await adminFetch(`/api/v1/service-requests/${item.id}/assign`, {
          body: {
            assignedPmUserId: bulkPm,
            reason: reason || undefined,
            expectedVersion: row.version,
          },
        });
        return 'reassigned';
      },
    });
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No requests match"
        description="Customer requests arrive from the portal intake and from converted leads. Adjust the filters or clear the saved view."
      />
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {actions.length > 0 ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={allSelected}
              aria-label="Select all rows on this page"
              onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
            />
            Select all on page
          </label>
        ) : (
          <span />
        )}
        <ExportCsvButton
          rows={rows}
          filename="service-requests.csv"
          columns={[
            { header: 'Reference', value: (r) => r.reference },
            { header: 'Title', value: (r) => r.title },
            { header: 'Status', value: (r) => r.status },
            { header: 'Priority', value: (r) => r.priority },
            { header: 'SLA due', value: (r) => r.slaDueAt },
            { header: 'SLA state', value: (r) => r.sla.state },
            { header: 'Service', value: (r) => r.serviceName },
            { header: 'Organisation', value: (r) => r.organizationName },
            { header: 'Project manager', value: (r) => r.assignedPm?.name ?? '' },
            { header: 'Created', value: (r) => r.createdAt },
          ]}
        />
      </div>
      <BulkActionBar
        selected={selectedItems}
        actions={actions}
        onClear={() => setSelected(new Set())}
        onDone={() => router.refresh()}
      />
      <DataTable
        caption="Service request queue"
        rows={rows}
        rowKey={(r) => r.id}
        rowLabel={(r) => `${r.reference} ${r.title}`}
        columns={[
          ...(actions.length > 0
            ? [
                {
                  key: 'select',
                  header: <span className="sr-only">Select</span>,
                  mobileLabel: 'Select',
                  cell: (r: QueueRow) => (
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={selected.has(r.id)}
                      aria-label={`Select ${r.reference}`}
                      onChange={() => toggle(r.id)}
                    />
                  ),
                },
              ]
            : []),
          {
            key: 'ref',
            header: 'Request',
            cell: (r) => (
              <span>
                <Link
                  href={`/admin/service-requests/${r.id}`}
                  className="font-medium text-primary underline"
                >
                  {r.reference}
                </Link>
                <br />
                <span className="text-xs text-fg-muted">{r.title}</span>
              </span>
            ),
          },
          { key: 'service', header: 'Service', cell: (r) => r.serviceName },
          {
            key: 'org',
            header: 'Organisation',
            cell: (r) => (
              <Link href={`/admin/customers/${r.organizationId}`} className="underline">
                {r.organizationName}
              </Link>
            ),
          },
          { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          {
            key: 'priority',
            header: 'Priority',
            cell: (r) => (
              <Badge tone={PRIORITY_TONE[r.priority] ?? 'neutral'}>
                {priorityLabel(r.priority)}
              </Badge>
            ),
          },
          {
            key: 'sla',
            header: 'SLA',
            cell: (r) => (
              <span>
                <Badge tone={SLA_TONE[r.sla.state]}>{r.sla.label}</Badge>
                {r.slaDueAt ? (
                  <span className="block text-xs text-fg-muted">
                    {formatDateTimeLabel(r.slaDueAt)}
                  </span>
                ) : null}
              </span>
            ),
          },
          {
            key: 'pm',
            header: 'Project manager',
            cell: (r) => r.assignedPm?.name ?? <span className="text-fg-muted">Unassigned</span>,
          },
          {
            key: 'created',
            header: 'Received',
            cell: (r) => formatDateTimeLabel(r.createdAt),
            hideOnMobile: true,
          },
        ]}
      />
      <p className="text-xs text-fg-muted">
        {humanize('sla')} clocks stop while a request is paused, delivered or closed.
      </p>
    </div>
  );
}
