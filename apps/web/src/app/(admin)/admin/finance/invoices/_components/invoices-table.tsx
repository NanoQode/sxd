'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { DataTable, StatusBadge, formatDateLabel, humanize } from '@simplexd/ui';
import type { InvoiceListRow } from '@/lib/admin/server/finance';
import { adminFetch } from '@/lib/admin/client';
import { BulkActionBar, type BulkAction } from '@/components/admin/bulk-action-bar';
import { ExportCsvButton } from '@/components/admin/export-csv-button';
import { Money } from '@/components/admin/money';

/**
 * Invoice table with row selection. Bulk "Issue drafts" previews which rows
 * are drafts (others are skipped with the reason) and issues them one server
 * call at a time with each invoice's version, so a concurrent edit fails that
 * row instead of being overwritten.
 */
export function InvoicesTable({ rows, canManage }: { rows: InvoiceListRow[]; canManage: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const selectedItems = rows
    .filter((r) => selected.has(r.id))
    .map((r) => ({ id: r.id, label: `${r.number} · ${r.organizationName}` }));

  const actions: BulkAction[] = canManage
    ? [
        {
          key: 'issue',
          label: 'Issue drafts',
          description:
            'Issues each selected draft invoice so the customer can pay it. Invoices that are not drafts are skipped.',
          eligible: (item) =>
            byId.get(item.id)?.status === 'draft'
              ? null
              : `already ${humanize(byId.get(item.id)?.status ?? 'unknown')}`,
          run: async (item) => {
            const inv = byId.get(item.id)!;
            const res = await adminFetch<{ status: string; number: string }>(
              `/api/v1/invoices/${item.id}/issue`,
              {
                body: { expectedVersion: inv.version },
              },
            );
            return `${res.number} is now ${humanize(res.status)}`;
          },
        },
      ]
    : [];

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {canManage ? (
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
            />
            Select all on this page
          </label>
        ) : (
          <span />
        )}
        <ExportCsvButton
          rows={rows}
          filename="invoices.csv"
          columns={[
            { header: 'Number', value: (r) => r.number },
            { header: 'Organisation', value: (r) => r.organizationName },
            { header: 'Kind', value: (r) => r.kind },
            { header: 'Status', value: (r) => r.status },
            { header: 'Currency', value: (r) => r.currency },
            { header: 'Total kobo', value: (r) => r.totalKobo },
            { header: 'Paid kobo', value: (r) => r.amountPaidKobo },
            { header: 'Credited kobo', value: (r) => r.amountCreditedKobo },
            { header: 'Balance kobo', value: (r) => r.balanceKobo },
            { header: 'Due date', value: (r) => r.dueDate },
            { header: 'Issued at', value: (r) => r.issuedAt },
            { header: 'Service request', value: (r) => r.serviceRequestReference },
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
        caption="Invoices"
        rows={rows}
        rowKey={(r) => r.id}
        rowLabel={(r) => r.number}
        emptyMessage="No invoices match these filters."
        columns={[
          ...(canManage
            ? [
                {
                  key: 'select',
                  header: <span className="sr-only">Select</span>,
                  cell: (r: InvoiceListRow) => (
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      aria-label={`Select ${r.number}`}
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                    />
                  ),
                },
              ]
            : []),
          {
            key: 'number',
            header: 'Invoice',
            cell: (r) => (
              <span>
                <Link
                  href={`/admin/finance/invoices/${r.id}`}
                  className="font-medium text-primary underline"
                >
                  {r.number}
                </Link>
                <span className="block text-xs text-fg-muted">{humanize(r.kind)}</span>
              </span>
            ),
          },
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
            key: 'total',
            header: 'Total',
            cell: (r) => <Money kobo={r.totalKobo} currency={r.currency} />,
          },
          {
            key: 'balance',
            header: 'Balance',
            cell: (r) => <Money kobo={r.balanceKobo} currency={r.currency} />,
          },
          {
            key: 'due',
            header: 'Due',
            cell: (r) => (r.dueDate ? formatDateLabel(r.dueDate) : '—'),
            hideOnMobile: true,
          },
          {
            key: 'request',
            header: 'Request',
            cell: (r) =>
              r.serviceRequestId ? (
                <Link href={`/admin/service-requests/${r.serviceRequestId}`} className="underline">
                  {r.serviceRequestReference ?? 'request'}
                </Link>
              ) : (
                '—'
              ),
            hideOnMobile: true,
          },
        ]}
      />
    </div>
  );
}
