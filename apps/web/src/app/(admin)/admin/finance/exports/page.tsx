import type { Metadata } from 'next';
import { Alert, DataTable, PageHeader, buttonVariants, humanize } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { searchOrganizations } from '@/lib/admin/server/customers';
import { allocationsReconciliation } from '@/lib/admin/server/finance';
import { FilterBar, FilterInput, FilterSelect } from '@/components/admin/filter-bar';
import { LoadError } from '@/components/admin/load-error';
import { Money } from '@/components/admin/money';
import { Section } from '@/components/admin/section';
import { DefinitionList, Mono } from '../../_components/bits';

export const metadata: Metadata = { title: 'Finance exports' };
export const dynamic = 'force-dynamic';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function FinanceExportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const identity = await requireStaffPage('finance.read');
  const raw = await searchParams;
  const query = {
    from: raw.from && DATE.test(raw.from) ? raw.from : undefined,
    to: raw.to && DATE.test(raw.to) ? raw.to : undefined,
    organizationId: raw.organizationId || undefined,
  };
  const [loaded, orgs] = await Promise.all([attempt(() => allocationsReconciliation(identity, query)), searchOrganizations(identity, undefined, 500)]);
  const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Exports"
        description="The allocation export has one row per allocation with its receipt and the balanced journal behind it. Before you download, the totals are checked against the receipts issued in the same window so the file reconciles to the underlying records."
      />
      <FilterBar submitLabel="Preview">
        <FilterInput name="from" label="From (allocated on or after)" type="date" value={query.from} />
        <FilterInput name="to" label="To (on or before)" type="date" value={query.to} />
        <FilterSelect name="organizationId" label="Organisation" value={query.organizationId} allLabel="All organisations" options={orgs.map((o) => ({ value: o.id, label: o.name }))} />
      </FilterBar>
      {!loaded.ok ? (
        <LoadError code={loaded.code} message={loaded.message} what="The allocation export" />
      ) : (
        <>
          <Section
            title="Reconciliation check"
            actions={
              <>
                <a href={`/api/v1/finance/exports/allocations.csv${qs ? `?${qs}` : ''}`} download className={buttonVariants({ size: 'sm' })}>
                  Download CSV
                </a>
                <a href={`/api/v1/finance/exports/allocations.json${qs ? `?${qs}` : ''}`} download className={buttonVariants({ size: 'sm', variant: 'secondary' })}>
                  Download JSON
                </a>
              </>
            }
          >
            {loaded.value.reconciles ? (
              <Alert tone="success" title="Export reconciles">
                {loaded.value.allocationsCount} allocations totalling the same amount as {loaded.value.receiptsCount} receipts in the window.
              </Alert>
            ) : (
              <Alert tone="danger" title="Export does not reconcile">
                Allocations and receipts differ for this window. Do not file this export; open the reconciliation queue and investigate before downloading.
              </Alert>
            )}
            <DefinitionList
              items={[
                { term: 'Allocations', value: loaded.value.allocationsCount },
                { term: 'Allocated total', value: <Money kobo={loaded.value.totalAllocatedKobo} /> },
                { term: 'Receipts', value: loaded.value.receiptsCount },
                { term: 'Receipts total', value: <Money kobo={loaded.value.receiptsTotalKobo} /> },
              ]}
            />
          </Section>
          <Section title="Preview (first 50 rows)">
            <DataTable
              caption="Allocation export preview"
              rows={loaded.value.rows.slice(0, 50)}
              rowKey={(r) => String(r.allocationId)}
              rowLabel={(r) => String(r.invoiceNumber)}
              emptyMessage="No allocations in this window."
              columns={[
                { key: 'at', header: 'Allocated', cell: (r) => String(r.allocatedAt ?? '').slice(0, 19).replace('T', ' ') },
                { key: 'inv', header: 'Invoice', cell: (r) => String(r.invoiceNumber ?? '') },
                { key: 'src', header: 'Source', cell: (r) => humanize(String(r.source ?? '')) },
                { key: 'amt', header: 'Amount', cell: (r) => <Money kobo={String(r.amountKobo ?? '')} currency={String(r.currency ?? 'NGN')} /> },
                { key: 'rcpt', header: 'Receipt', cell: (r) => <Mono>{String(r.receiptNumber ?? '')}</Mono>, hideOnMobile: true },
                { key: 'jr', header: 'Journal Dr / Cr', cell: (r) => <span><Money kobo={String(r.journalDebitKobo ?? '')} /> / <Money kobo={String(r.journalCreditKobo ?? '')} /></span>, hideOnMobile: true },
              ]}
            />
          </Section>
        </>
      )}
    </div>
  );
}
