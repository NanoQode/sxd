import type { Metadata } from 'next';
import Link from 'next/link';
import { paymentAttemptStatusSchema } from '@simplexd/contracts';
import {
  Badge,
  DataTable,
  PageHeader,
  StatusBadge,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { attempt, can } from '@/lib/admin/server/context';
import { reconciliationView } from '@/lib/admin/server/finance';
import { ApiAction } from '@/components/admin/api-action';
import { FilterBar, FilterSelect } from '@/components/admin/filter-bar';
import { LoadError } from '@/components/admin/load-error';
import { Money } from '@/components/admin/money';
import { Section } from '@/components/admin/section';
import { Mono } from '../../_components/bits';

export const metadata: Metadata = { title: 'Reconciliation' };
export const dynamic = 'force-dynamic';

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireStaffPage('finance.read');
  const raw = await searchParams;
  const status = paymentAttemptStatusSchema.safeParse(raw.status).success ? raw.status : undefined;
  const loaded = await attempt(() => reconciliationView(identity, { status }));
  const canReconcile = can(identity, 'finance.reconcile');
  return (
    <div className="space-y-6">
      <PageHeader
        title="Reconciliation"
        description="Gateway payments that are not settled yet, and exceptions found by the reconciliation job (amount or currency mismatches, reversals, chargebacks). Verification asks the provider again; a mismatch never settles an invoice."
      />
      <FilterBar>
        <FilterSelect
          name="status"
          label="Attempt status"
          value={status}
          allLabel="Open (initialized, pending, uncertain, reversed)"
          options={paymentAttemptStatusSchema.options.map((s) => ({
            value: s,
            label: humanize(s),
          }))}
        />
      </FilterBar>
      {!loaded.ok ? (
        <LoadError code={loaded.code} message={loaded.message} what="Reconciliation" />
      ) : (
        <>
          <Section title={`Payment attempts (${loaded.value.attempts.length})`}>
            <DataTable
              caption="Payment attempts awaiting reconciliation"
              rows={loaded.value.attempts}
              rowKey={(a) => a.id}
              rowLabel={(a) => a.reference}
              emptyMessage="Nothing is waiting for verification."
              columns={[
                { key: 'ref', header: 'Reference', cell: (a) => <Mono>{a.reference}</Mono> },
                {
                  key: 'inv',
                  header: 'Invoice',
                  cell: (a) => (
                    <Link href={`/admin/finance/invoices/${a.invoiceId}`} className="underline">
                      open
                    </Link>
                  ),
                },
                { key: 'st', header: 'Status', cell: (a) => <StatusBadge status={a.status} /> },
                {
                  key: 'amt',
                  header: 'Amount',
                  cell: (a) => <Money kobo={a.amountKobo} currency={a.currency} />,
                },
                {
                  key: 'env',
                  header: 'Provider',
                  cell: (a) => (
                    <span>
                      {a.provider} · {a.environment}
                      {a.developmentAdapter ? (
                        <Badge tone="warning" className="ml-1">
                          dev adapter
                        </Badge>
                      ) : null}
                    </span>
                  ),
                  hideOnMobile: true,
                },
                {
                  key: 'when',
                  header: 'Started',
                  cell: (a) => formatDateTimeLabel(a.createdAt),
                  hideOnMobile: true,
                },
                {
                  key: 'why',
                  header: 'Note',
                  cell: (a) => a.failureReason ?? '—',
                  hideOnMobile: true,
                },
                {
                  key: 'act',
                  header: 'Action',
                  cell: (a) =>
                    canReconcile && ['initialized', 'pending', 'uncertain'].includes(a.status) ? (
                      <ApiAction
                        path={`/api/v1/payment-attempts/${a.id}/verify`}
                        label="Verify now"
                        successMessage="Verification recorded"
                      />
                    ) : (
                      '—'
                    ),
                },
              ]}
            />
          </Section>
          <Section
            title={`Exceptions (${loaded.value.exceptions.length})`}
            description="Each exception names the record to inspect. Corrections are new records (credit notes, reversals), never edits."
          >
            <DataTable
              caption="Reconciliation exceptions"
              rows={loaded.value.exceptions}
              rowKey={(e) => `${e.reconciliationId}-${e.code}-${e.entityId ?? ''}`}
              rowLabel={(e) => e.code}
              emptyMessage="No exceptions recorded."
              columns={[
                { key: 'period', header: 'Run', cell: (e) => e.periodStart },
                { key: 'code', header: 'Code', cell: (e) => <Mono>{e.code}</Mono> },
                { key: 'msg', header: 'Message', cell: (e) => e.message },
                {
                  key: 'entity',
                  header: 'Record',
                  cell: (e) =>
                    (e.entityType === 'payment_attempt' || e.entityType === 'invoice') &&
                    e.entityId ? (
                      e.entityType === 'invoice' ? (
                        <Link href={`/admin/finance/invoices/${e.entityId}`} className="underline">
                          invoice
                        </Link>
                      ) : (
                        <Mono>{e.entityId.slice(0, 8)}</Mono>
                      )
                    ) : (
                      (e.entityType ?? '—')
                    ),
                },
                {
                  key: 'st',
                  header: 'Run status',
                  cell: (e) => (
                    <StatusBadge
                      status={e.status === 'exceptions' ? 'open' : e.status}
                      label={humanize(e.status)}
                    />
                  ),
                },
              ]}
            />
          </Section>
        </>
      )}
    </div>
  );
}
