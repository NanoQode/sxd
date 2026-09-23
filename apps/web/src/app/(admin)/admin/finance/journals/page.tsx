import type { Metadata } from 'next';
import { Badge, PageHeader, formatDateTimeLabel } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { searchOrganizations } from '@/lib/admin/server/customers';
import { listJournals } from '@/lib/admin/server/finance';
import { FilterBar, FilterInput, FilterSelect } from '@/components/admin/filter-bar';
import { Money } from '@/components/admin/money';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';
import { Pagination } from '../../_components/pagination';
import { Mono } from '../../_components/bits';

export const metadata: Metadata = { title: 'Journals' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

export default async function JournalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireStaffPage('finance.read');
  const raw = await searchParams;
  const page = Math.max(1, Number(raw.page) || 1);
  const [result, orgs] = await Promise.all([
    listJournals(identity, {
      organizationId: raw.organizationId || undefined,
      sourceType: raw.sourceType?.trim() || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    searchOrganizations(identity, undefined, 500),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Journals"
        description="Posted, immutable, balanced journals with a unique business-event reference each. Corrections appear as reversing journals; nothing here can be edited."
      />
      <SavedViewsBar tableKey="finance-journals" />
      <FilterBar>
        <FilterSelect
          name="organizationId"
          label="Organisation"
          value={raw.organizationId}
          allLabel="All"
          options={orgs.map((o) => ({ value: o.id, label: o.name }))}
        />
        <FilterInput
          name="sourceType"
          label="Source type"
          value={raw.sourceType}
          placeholder="e.g. allocation, refund"
        />
      </FilterBar>
      {result.items.length === 0 ? <p className="text-fg-muted">No journals match.</p> : null}
      <ol className="space-y-3">
        {result.items.map((j) => (
          <li key={j.id} className="rounded-lg border border-border bg-bg-elevated p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">
                <Mono>{j.businessEventRef}</Mono>{' '}
                {j.description ? <span className="text-fg-muted">· {j.description}</span> : null}
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                {formatDateTimeLabel(j.postedAt)} · {j.postedByName ?? 'system'}
                {j.organizationName ? ` · ${j.organizationName}` : ''}
                {j.reversalOfJournalId ? <Badge tone="warning">reversal</Badge> : null}
                <Badge tone={j.balanced ? 'success' : 'danger'}>
                  {j.balanced ? 'balanced' : 'NOT balanced'}
                </Badge>
              </span>
            </div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-xs">
                <caption className="sr-only">Lines of journal {j.businessEventRef}</caption>
                <thead>
                  <tr className="text-fg-muted">
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Account
                    </th>
                    <th scope="col" className="py-1 pr-2 text-right font-medium">
                      Debit
                    </th>
                    <th scope="col" className="py-1 pr-2 text-right font-medium">
                      Credit
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      Memo
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {j.lines.map((l) => (
                    <tr key={l.lineNo} className="border-t border-border">
                      <td className="py-1 pr-2">
                        <Mono>{l.accountCode}</Mono> {l.accountName}
                      </td>
                      <td className="py-1 pr-2 text-right">
                        {l.debitKobo !== '0' ? <Money kobo={l.debitKobo} /> : ''}
                      </td>
                      <td className="py-1 pr-2 text-right">
                        {l.creditKobo !== '0' ? <Money kobo={l.creditKobo} /> : ''}
                      </td>
                      <td className="py-1 text-fg-muted">{l.memo ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {j.sourceType ? (
              <p className="mt-1 text-xs text-fg-muted">
                Source: {j.sourceType} {j.sourceId ? <Mono>{j.sourceId.slice(0, 8)}</Mono> : null}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      <Pagination page={page} pageSize={PAGE_SIZE} total={result.total} />
    </div>
  );
}
