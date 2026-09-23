import type { ReactNode } from 'react';
import type { RentChargeDto, RentScheduleDto } from '@simplexd/contracts';
import { DataTable, StatusBadge } from '@simplexd/ui';
import {
  CHARGE_KIND_LABELS,
  formatDay,
  formatMoney,
  isPositiveKobo,
  type TenantInvoice,
} from '@/lib/tenant/model';

/** Charges on the caller's lease with what has been settled against each. */
export function ChargesTable({ charges, currency }: { charges: RentChargeDto[]; currency: string }) {
  const rows = [...charges].sort((a, b) => b.chargedAt.localeCompare(a.chargedAt));
  return (
    <DataTable
      caption="Charges on this lease"
      rows={rows}
      rowKey={(c) => c.id}
      rowLabel={(c) => `${c.description} (${formatDay(c.chargedAt)})`}
      emptyMessage="No charges have been raised on this lease yet. Rent charges appear once the schedule is generated."
      columns={[
        {
          key: 'description',
          header: 'Charge',
          mobileLabel: 'Type',
          cell: (c) => (
            <span>
              <span className="hidden md:inline">{c.description}</span>
              <span className="block text-xs text-fg-muted md:mt-0.5">
                {CHARGE_KIND_LABELS[c.kind] ?? c.kind}
              </span>
            </span>
          ),
        },
        { key: 'date', header: 'Charged', cell: (c) => formatDay(c.chargedAt) },
        {
          key: 'amount',
          header: 'Amount',
          className: 'text-right tabular-nums',
          cell: (c) => formatMoney(c.amountKobo, currency),
        },
        {
          key: 'paid',
          header: 'Paid',
          className: 'text-right tabular-nums',
          cell: (c) => formatMoney(c.paidKobo, currency),
        },
        {
          key: 'outstanding',
          header: 'Outstanding',
          className: 'text-right tabular-nums',
          cell: (c) =>
            isPositiveKobo(c.outstandingKobo) ? (
              <strong>{formatMoney(c.outstandingKobo, currency)}</strong>
            ) : (
              <StatusBadge status="paid" />
            ),
        },
      ]}
    />
  );
}

/** Rent periods from the lease schedule (period, due date, amount, status). */
export function ScheduleTable({
  schedule,
  currency,
}: {
  schedule: RentScheduleDto[];
  currency: string;
}) {
  return (
    <DataTable
      caption="Rent schedule"
      rows={schedule}
      rowKey={(s) => s.id}
      rowLabel={(s) => `${formatDay(s.periodStart)} – ${formatDay(s.periodEnd)}`}
      emptyMessage="No rent schedule yet. It is generated when the lease becomes active."
      columns={[
        {
          key: 'period',
          header: 'Period',
          hideOnMobile: true,
          cell: (s) => `${formatDay(s.periodStart)} – ${formatDay(s.periodEnd)}`,
        },
        { key: 'due', header: 'Due', cell: (s) => formatDay(s.dueDate) },
        {
          key: 'amount',
          header: 'Rent',
          className: 'text-right tabular-nums',
          cell: (s) => formatMoney(s.amountKobo, currency),
        },
        { key: 'status', header: 'Status', cell: (s) => <StatusBadge status={s.status} /> },
      ]}
    />
  );
}

/** Invoices raised to the caller for this lease. */
export function InvoicesTable({
  invoices,
  payAction,
}: {
  invoices: TenantInvoice[];
  payAction?: (invoice: TenantInvoice) => ReactNode;
}) {
  return (
    <DataTable
      caption="Invoices for this lease"
      rows={invoices}
      rowKey={(i) => i.id}
      rowLabel={(i) => `Invoice ${i.number}`}
      emptyMessage="No invoices have been issued to you for this lease yet. Rent invoices are issued shortly before each due date."
      columns={[
        { key: 'number', header: 'Invoice', hideOnMobile: true, cell: (i) => i.number },
        { key: 'due', header: 'Due', cell: (i) => formatDay(i.dueDate) },
        {
          key: 'total',
          header: 'Total',
          className: 'text-right tabular-nums',
          cell: (i) => formatMoney(i.totalKobo, i.currency),
        },
        {
          key: 'balance',
          header: 'Balance',
          className: 'text-right tabular-nums',
          cell: (i) => formatMoney(i.balanceKobo, i.currency),
        },
        { key: 'status', header: 'Status', cell: (i) => <StatusBadge status={i.status} /> },
        ...(payAction
          ? [{ key: 'pay', header: <span className="sr-only">Actions</span>, mobileLabel: 'Pay', cell: payAction }]
          : []),
      ]}
    />
  );
}
