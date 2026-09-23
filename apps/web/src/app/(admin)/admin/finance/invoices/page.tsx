import type { Metadata } from 'next';
import Link from 'next/link';
import { invoiceStatusSchema, type InvoiceDto } from '@simplexd/contracts';
import { PageHeader, humanize } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { can } from '@/lib/admin/server/context';
import { searchOrganizations } from '@/lib/admin/server/customers';
import { listInvoicesView } from '@/lib/admin/server/finance';
import { FilterBar, FilterInput, FilterSelect } from '@/components/admin/filter-bar';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';
import { InvoiceCreateDialog } from './_components/invoice-create-dialog';
import { InvoicesTable } from './_components/invoices-table';

export const metadata: Metadata = { title: 'Invoices' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireStaffPage('finance.read');
  const raw = await searchParams;
  const status = invoiceStatusSchema.safeParse(raw.status).success
    ? (raw.status as InvoiceDto['status'])
    : undefined;
  const serviceRequestId =
    raw.serviceRequestId && UUID.test(raw.serviceRequestId) ? raw.serviceRequestId : undefined;
  const [page, organizations] = await Promise.all([
    listInvoicesView(identity, {
      status,
      organizationId: raw.organizationId || undefined,
      serviceRequestId,
      cursor: raw.cursor || undefined,
      limit: PAGE_SIZE,
    }),
    searchOrganizations(identity, undefined, 500),
  ]);
  const canManage = can(identity, 'finance.invoices.manage');
  const nextParams = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) if (v && k !== 'cursor') nextParams.set(k, v);
  const firstHref = `/admin/finance/invoices${nextParams.size ? `?${nextParams.toString()}` : ''}`;
  if (page.nextCursor) nextParams.set('cursor', page.nextCursor);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Invoices"
        description="Draft, issued, partially paid, paid, overdue and void. Credit notes and refunds are separate records; a void invoice keeps its history."
        actions={
          <InvoiceCreateDialog
            organizations={organizations}
            defaultOrganizationId={raw.organizationId}
            defaultServiceRequestId={serviceRequestId}
            canManage={canManage}
          />
        }
      />
      <SavedViewsBar tableKey="finance-invoices" />
      <FilterBar>
        <FilterSelect
          name="status"
          label="Status"
          value={status}
          options={invoiceStatusSchema.options.map((s) => ({ value: s, label: humanize(s) }))}
        />
        <FilterSelect
          name="organizationId"
          label="Organisation"
          value={raw.organizationId}
          allLabel="All organisations"
          options={organizations.map((o) => ({ value: o.id, label: o.name }))}
        />
        <FilterInput
          name="serviceRequestId"
          label="Service request id"
          value={serviceRequestId}
          placeholder="UUID"
        />
      </FilterBar>
      <InvoicesTable rows={page.items} canManage={canManage} />
      <nav aria-label="Invoice pages" className="flex flex-wrap items-center gap-3 text-sm">
        {raw.cursor ? (
          <Link href={firstHref} className="underline">
            First page
          </Link>
        ) : null}
        {page.nextCursor ? (
          <Link href={`/admin/finance/invoices?${nextParams.toString()}`} className="underline">
            Next page
          </Link>
        ) : (
          <span className="text-fg-muted">End of list</span>
        )}
      </nav>
    </div>
  );
}
