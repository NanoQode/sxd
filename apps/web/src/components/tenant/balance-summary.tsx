import type { LeaseBalanceDto } from '@simplexd/contracts';
import { ageingRows, formatDay, formatMoney, isPositiveKobo, overdueKobo } from '@/lib/tenant/model';

/** Headline figures of the caller's balance on one lease, exactly as the API computed them. */
export function BalanceFigures({ balance }: { balance: LeaseBalanceDto }) {
  const overdue = overdueKobo(balance.arrears);
  const figures = [
    {
      label: 'Outstanding',
      value: formatMoney(balance.outstandingKobo, balance.currency),
      note: 'Every unpaid charge raised so far, including periods not yet due.',
    },
    {
      label: 'Overdue',
      value: formatMoney(overdue, balance.currency),
      note: isPositiveKobo(overdue) ? 'Past its due date.' : 'Nothing is past its due date.',
    },
    {
      label: 'Next charge',
      value: balance.nextDue ? formatMoney(balance.nextDue.amountKobo, balance.currency) : '—',
      note: balance.nextDue
        ? `Due ${formatDay(balance.nextDue.dueDate)}.`
        : 'No further charge is scheduled.',
    },
    {
      label: 'Paid to date',
      value: formatMoney(balance.paidKobo, balance.currency),
      note: `Of ${formatMoney(balance.chargedKobo, balance.currency)} charged. Settled money only.`,
    },
    {
      label: 'Deposit held',
      value: formatMoney(balance.depositHeldKobo, balance.currency),
      note: 'Deposit received and held under the lease.',
    },
  ];
  return (
    <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {figures.map((f) => (
        <div key={f.label} className="rounded-lg border border-border bg-bg-elevated p-4">
          <dt className="text-sm text-fg-muted">{f.label}</dt>
          <dd className="font-display text-2xl font-semibold">{f.value}</dd>
          <dd className="mt-1 text-xs text-fg-muted">{f.note}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Arrears ageing by days past the due date (buckets from the balance endpoint). */
export function ArrearsAgeing({ balance }: { balance: LeaseBalanceDto }) {
  const rows = ageingRows(balance.arrears);
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <caption className="sr-only">
          Arrears ageing as of {formatDay(balance.arrears.asOf)}
        </caption>
        <thead className="bg-bg-sunken text-left text-xs tracking-wide text-fg-muted uppercase">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Age
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-border">
              <th scope="row" className="px-3 py-2 text-left font-normal">
                {r.label}
              </th>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatMoney(r.amountKobo, balance.currency)}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-border-strong font-medium">
            <th scope="row" className="px-3 py-2 text-left">
              Total outstanding
            </th>
            <td className="px-3 py-2 text-right tabular-nums">
              {formatMoney(balance.arrears.totalOutstandingKobo, balance.currency)}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="border-t border-border px-3 py-2 text-xs text-fg-muted">
        As of {formatDay(balance.arrears.asOf)}. Amounts are grouped by how many days they are past
        their due date.
      </p>
    </div>
  );
}
