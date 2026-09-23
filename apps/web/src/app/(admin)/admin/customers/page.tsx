import type { Metadata } from 'next';
import Link from 'next/link';
import { DataTable, EmptyState, PageHeader, formatDateLabel, humanize } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { listCustomerOrganizations } from '@/lib/admin/server/customers';
import { FilterBar, FilterInput } from '@/components/admin/filter-bar';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';
import { Pagination } from '../_components/pagination';

export const metadata: Metadata = { title: 'Customers' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireStaffPage('customers.read');
  const raw = await searchParams;
  const page = Math.max(1, Number(raw.page) || 1);
  const result = await listCustomerOrganizations(identity, {
    q: raw.q?.trim() || undefined,
    page,
    pageSize: PAGE_SIZE,
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Customers"
        description="Customer organisations, their members, properties, requests and invoices. Sensitive contact fields are masked unless your role holds customers.read_sensitive."
      />
      <SavedViewsBar tableKey="customers" />
      <FilterBar>
        <FilterInput
          name="q"
          label="Search"
          value={raw.q}
          placeholder="Organisation name or slug"
        />
      </FilterBar>
      {result.items.length === 0 ? (
        <EmptyState
          title="No customer organisations match"
          description="Organisations are created when a customer signs up or accepts an invitation."
        />
      ) : (
        <DataTable
          caption="Customer organisations"
          rows={result.items}
          rowKey={(o) => o.id}
          rowLabel={(o) => o.name}
          columns={[
            {
              key: 'name',
              header: 'Organisation',
              cell: (o) => (
                <span>
                  <Link
                    href={`/admin/customers/${o.id}`}
                    className="font-medium text-primary underline"
                  >
                    {o.name}
                  </Link>
                  <br />
                  <span className="text-xs text-fg-muted">{o.slug}</span>
                </span>
              ),
            },
            {
              key: 'type',
              header: 'Type',
              cell: (o) =>
                `${humanize(o.kind)}${o.ownershipType ? ` · ${humanize(o.ownershipType)}` : ''}`,
            },
            {
              key: 'country',
              header: 'Country',
              cell: (o) => o.countryCode ?? '—',
              hideOnMobile: true,
            },
            { key: 'members', header: 'Members', cell: (o) => o.memberCount },
            {
              key: 'requests',
              header: 'Requests (open)',
              cell: (o) => `${o.requestCount} (${o.openRequestCount})`,
            },
            {
              key: 'created',
              header: 'Since',
              cell: (o) => formatDateLabel(o.createdAt),
              hideOnMobile: true,
            },
          ]}
        />
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} total={result.total} />
    </div>
  );
}
