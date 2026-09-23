import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { uuidSchema } from '@simplexd/contracts';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  PageHeader,
  StatusBadge,
  formatDateLabel,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { koboToNaira } from '@/lib/portal/format';
import { loadOwnerStatement, propertyNames } from '@/lib/portal/server/rentals';
import { STATEMENT_LINE_LABELS, sumLines } from '@/lib/portal/statements';

export const metadata: Metadata = { title: 'Owner statement' };
export const dynamic = 'force-dynamic';

export default async function OwnerStatementPage({
  params,
}: {
  params: Promise<{ statementId: string }>;
}) {
  const { statementId } = await params;
  if (!uuidSchema.safeParse(statementId).success) notFound();
  const identity = await requireSignedIn(`/portal/properties/statements/${statementId}`);
  const statement = await loadOwnerStatement(identity, statementId);
  if (!statement) notFound();
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const names = await propertyNames(identity, [statement.propertyId]);
  const propertyName = statement.propertyId ? (names.get(statement.propertyId) ?? null) : null;
  const propertyHref = statement.propertyId ? `/portal/properties/${statement.propertyId}` : null;
  const { totals, lines, reconciliation } = statement;
  const rent = sumLines(lines, ['rent_collected']);
  const serviceCharge = sumLines(lines, ['service_charge_collected']);
  const shortStay = sumLines(lines, ['short_stay_income']);

  const summary: Array<{ label: string; value: string; hint?: string; strong?: boolean }> = [
    { label: 'Rent collected', value: rent, hint: 'Settled rent allocations in the period.' },
    ...(serviceCharge !== '0' ? [{ label: 'Service charge collected', value: serviceCharge }] : []),
    ...(shortStay !== '0' ? [{ label: 'Short-stay income', value: shortStay }] : []),
    { label: 'Total collected', value: totals.collectedKobo },
    {
      label: 'Management fee',
      value: totals.feesKobo,
      hint: 'Per lease, on the basis agreed in the lease.',
    },
    {
      label: 'Maintenance recoveries',
      value: totals.expensesKobo,
      hint: 'Verified work orders charged to the property.',
    },
    { label: 'Net payable to you', value: totals.netKobo, strong: true },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/portal/properties/statements" className="underline">
            Owner statements
          </Link>
        }
        title={`${formatDateLabel(statement.periodStart, zone)} – ${formatDateLabel(statement.periodEnd, zone)}`}
        description={
          propertyName && propertyHref ? (
            <Link href={propertyHref} className="underline">
              {propertyName}
            </Link>
          ) : (
            'Portfolio statement'
          )
        }
        actions={<StatusBadge status={statement.status} />}
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr] [&>*]:min-w-0">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
              <CardDescription>
                Amounts in NGN from settled allocations and posted journals; a payout is a separate,
                dual-approved step.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="divide-y divide-border text-sm">
                {summary.map((row) => (
                  <div
                    key={row.label}
                    className={`flex flex-wrap items-baseline justify-between gap-2 py-2 ${row.strong ? 'text-base font-semibold' : ''}`}
                  >
                    <dt>
                      {row.label}
                      {row.hint ? (
                        <span className="block text-xs font-normal text-fg-muted">{row.hint}</span>
                      ) : null}
                    </dt>
                    <dd className="tabular-nums">{koboToNaira(row.value)}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Line items</CardTitle>
              <CardDescription>Every figure above comes from these lines.</CardDescription>
            </CardHeader>
            <CardContent>
              {lines.length === 0 ? (
                <p className="text-sm text-fg-muted">No activity was recorded in this period.</p>
              ) : (
                <DataTable
                  caption="Statement lines"
                  rows={lines.map((l, i) => ({ ...l, key: `${l.kind}-${i}` }))}
                  rowKey={(l) => l.key}
                  rowLabel={(l) => l.description}
                  columns={[
                    {
                      key: 'kind',
                      header: 'Type',
                      cell: (l) => STATEMENT_LINE_LABELS[l.kind] ?? humanize(l.kind),
                    },
                    {
                      key: 'description',
                      header: 'Description',
                      cell: (l) => (
                        <span>
                          {l.description}
                          {l.feeBps !== null && l.feeBps !== undefined ? (
                            <span className="text-fg-muted"> · {(l.feeBps / 100).toFixed(2)}%</span>
                          ) : null}
                          {l.workOrderId && propertyHref ? (
                            <>
                              {' '}
                              <Link
                                href={`${propertyHref}?tab=maintenance`}
                                className="text-primary underline"
                              >
                                work order
                              </Link>
                            </>
                          ) : null}
                        </span>
                      ),
                    },
                    {
                      key: 'amount',
                      header: 'Amount',
                      cell: (l) => koboToNaira(l.amountKobo),
                      className: 'text-right tabular-nums',
                    },
                  ]}
                />
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Reconciliation</CardTitle>
              <CardDescription>
                The statement is checked against payment allocations and the fee and recovery
                journals before you see it.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {reconciliation ? (
                <>
                  <Alert
                    tone={reconciliation.matches ? 'success' : 'warning'}
                    title={
                      reconciliation.matches ? 'Matches the ledger' : 'Does not match the ledger'
                    }
                  >
                    {reconciliation.matches
                      ? 'Collected, fee and recovery figures equal the posted ledger entries.'
                      : 'Finance is investigating a difference; figures may change before issue.'}
                  </Alert>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <dt className="text-fg-muted">Allocations</dt>
                    <dd className="text-right tabular-nums">
                      {koboToNaira(reconciliation.allocationsKobo)}
                    </dd>
                    <dt className="text-fg-muted">Fee journal</dt>
                    <dd className="text-right tabular-nums">
                      {koboToNaira(reconciliation.feeJournalKobo)}
                    </dd>
                    <dt className="text-fg-muted">Recovery journal</dt>
                    <dd className="text-right tabular-nums">
                      {koboToNaira(reconciliation.recoveryJournalKobo)}
                    </dd>
                  </dl>
                </>
              ) : (
                <p className="text-fg-muted">No reconciliation has been recorded.</p>
              )}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border pt-3">
                <dt className="text-fg-muted">Generated</dt>
                <dd>{formatDateTimeLabel(statement.generatedAt, zone)}</dd>
                <dt className="text-fg-muted">Reconciled</dt>
                <dd>
                  {statement.reconciledAt ? formatDateTimeLabel(statement.reconciledAt, zone) : '—'}
                </dd>
                <dt className="text-fg-muted">Issued</dt>
                <dd>
                  {statement.issuedAt ? formatDateTimeLabel(statement.issuedAt, zone) : 'Not yet'}
                </dd>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Arrears and open items</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="flex justify-between gap-2">
                <span className="text-fg-muted">Arrears at period end</span>
                <span className="tabular-nums">{koboToNaira(totals.arrearsKobo)}</span>
              </p>
              {totals.openObligations.length === 0 ? (
                <p className="text-fg-muted">No open obligations.</p>
              ) : (
                <ul className="space-y-1">
                  {totals.openObligations.map((o, i) => (
                    <li key={`${o.description}-${i}`} className="flex justify-between gap-2">
                      <span>{o.description}</span>
                      <span className="tabular-nums">{koboToNaira(o.amountKobo)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
