import type { Metadata } from 'next';
import Link from 'next/link';
import { ownerStatementStatusSchema, type OwnerStatementListQuery } from '@simplexd/contracts';
import { Badge, DataTable, PageHeader, formatDateLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt, can } from '@/lib/admin/server/context';
import { searchOrganizations } from '@/lib/admin/server/customers';
import { listAllProperties } from '@/lib/admin/server/properties';
import { listStatementsView } from '@/lib/admin/server/rentals';
import { FilterBar, FilterSelect } from '@/components/admin/filter-bar';
import { FormDialog } from '@/components/admin/form-dialog';
import { LoadError } from '@/components/admin/load-error';
import { Money } from '@/components/admin/money';

export const metadata: Metadata = { title: 'Owner statements' };
export const dynamic = 'force-dynamic';

export default async function StatementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireSignedIn('/admin/rentals/statements');
  const raw = await searchParams;
  const status = ownerStatementStatusSchema.safeParse(raw.status).success
    ? (raw.status as OwnerStatementListQuery['status'])
    : undefined;
  const [loaded, orgs, props] = await Promise.all([
    attempt(() =>
      listStatementsView(identity, {
        status,
        organizationId: raw.organizationId || undefined,
        cursor: raw.cursor || undefined,
        limit: 50,
      }),
    ),
    attempt(() => searchOrganizations(identity, undefined, 500)),
    attempt(() => listAllProperties(identity, { status: 'active' })),
  ]);
  if (!loaded.ok)
    return <LoadError code={loaded.code} message={loaded.message} what="Owner statements" />;
  const organizations = orgs.ok ? orgs.value : [];
  return (
    <div className="space-y-6">
      <PageHeader
        title="Owner statements"
        description="Draft → reconciled → issued. A statement shows rent and service charges collected (settled money only), management fees under each lease's own terms, verified maintenance recovered, arrears (shown, never netted) and open obligations. Reconciling posts the fee and recovery journals and succeeds only when every figure matches the ledger."
        actions={
          can(identity, 'rentals.manage') ? (
            <FormDialog
              trigger="Generate statement"
              title="Generate an owner statement"
              description="Creates a draft for the period; reconcile it before issuing or paying out."
              path="/api/v1/owner-statements"
              variant="primary"
              size="md"
              successMessage="Draft statement generated"
              redirectTo="/admin/rentals/statements/{id}"
              fields={[
                {
                  name: 'organizationId',
                  label: 'Owner organisation',
                  type: 'select',
                  required: true,
                  options: organizations.map((o) => ({ value: o.id, label: o.name })),
                },
                {
                  name: 'propertyId',
                  label: 'Property (optional)',
                  type: 'select',
                  options: (props.ok ? props.value.items : []).map((p) => ({
                    value: p.id,
                    label: p.name,
                  })),
                  emptyAs: 'null',
                },
                { name: 'periodStart', label: 'Period start', type: 'date', required: true },
                { name: 'periodEnd', label: 'Period end', type: 'date', required: true },
              ]}
            />
          ) : undefined
        }
      />
      <FilterBar>
        <FilterSelect
          name="status"
          label="Status"
          value={status}
          options={ownerStatementStatusSchema.options.map((s) => ({
            value: s,
            label: humanize(s),
          }))}
        />
        <FilterSelect
          name="organizationId"
          label="Owner"
          value={raw.organizationId}
          allLabel="All"
          options={organizations.map((o) => ({ value: o.id, label: o.name }))}
        />
      </FilterBar>
      <DataTable
        caption="Owner statements"
        rows={loaded.value.items}
        rowKey={(s) => s.id}
        rowLabel={(s) => `${s.organizationName} ${s.periodStart}`}
        emptyMessage="No statements yet."
        columns={[
          {
            key: 'p',
            header: 'Period',
            cell: (s) => (
              <Link
                href={`/admin/rentals/statements/${s.id}`}
                className="font-medium text-primary underline"
              >
                {formatDateLabel(s.periodStart)} → {formatDateLabel(s.periodEnd)}
              </Link>
            ),
          },
          {
            key: 'o',
            header: 'Owner',
            cell: (s) => (
              <span>
                {s.organizationName}
                {s.propertyName ? (
                  <span className="block text-xs text-fg-muted">{s.propertyName}</span>
                ) : null}
              </span>
            ),
          },
          {
            key: 's',
            header: 'Status',
            cell: (s) => (
              <Badge
                tone={
                  s.status === 'issued' ? 'success' : s.status === 'reconciled' ? 'info' : 'neutral'
                }
              >
                {humanize(s.status)}
              </Badge>
            ),
          },
          {
            key: 'c',
            header: 'Collected',
            cell: (s) => <Money kobo={s.totals.collectedKobo} />,
            hideOnMobile: true,
          },
          {
            key: 'f',
            header: 'Fees',
            cell: (s) => <Money kobo={s.totals.feesKobo} />,
            hideOnMobile: true,
          },
          { key: 'n', header: 'Net payable', cell: (s) => <Money kobo={s.totals.netKobo} /> },
          {
            key: 'a',
            header: 'Arrears',
            cell: (s) => <Money kobo={s.totals.arrearsKobo} />,
            hideOnMobile: true,
          },
        ]}
      />
    </div>
  );
}
