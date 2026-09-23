import type { Metadata } from 'next';
import Link from 'next/link';
import { engagementStatusSchema } from '@simplexd/contracts';
import { DataTable, EmptyState, PageHeader, StatusBadge, formatDateLabel } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { listServiceRequests } from '@/server/requests/queries';

export const metadata: Metadata = { title: 'Requests' };
export const dynamic = 'force-dynamic';

const STATUS_FILTERS = [
  'inquiry',
  'triage',
  'quoted',
  'accepted',
  'in_progress',
  'delivered',
  'completed',
  'paused',
  'cancelled',
] as const;

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const identity = await requireSignedIn('/portal/requests');
  const params = await searchParams;
  const status = engagementStatusSchema.safeParse(params.status);
  const page = await listServiceRequests(identity, {
    status: status.success ? status.data : undefined,
    cursor: params.cursor,
    limit: 25,
  });
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const hasOrg = Boolean(identity.ctx.organizationId);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Requests"
        description="Every service request follows the same pipeline: inquiry, triage, quotation, acceptance, work, review, delivery and completion."
        actions={
          hasOrg ? (
            <Link
              href="/portal/requests/new"
              className="sx-touch inline-flex items-center rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary hover:bg-primary-hover"
            >
              New request
            </Link>
          ) : undefined
        }
      />
      <nav aria-label="Filter by status" className="flex flex-wrap gap-2">
        <Link
          href="/portal/requests"
          className={`sx-touch inline-flex items-center rounded-full border px-3 text-sm ${!status.success ? 'border-primary bg-primary-soft text-primary' : 'border-border text-fg-muted'}`}
        >
          All
        </Link>
        {STATUS_FILTERS.map((s) => (
          <Link
            key={s}
            href={`/portal/requests?status=${s}`}
            className={`sx-touch inline-flex items-center rounded-full border px-3 text-sm ${status.success && status.data === s ? 'border-primary bg-primary-soft text-primary' : 'border-border text-fg-muted'}`}
          >
            {s.replace(/_/g, ' ')}
          </Link>
        ))}
      </nav>
      {page.items.length === 0 ? (
        <EmptyState
          title={
            status.success ? `No ${status.data.replace(/_/g, ' ')} requests` : 'No requests yet'
          }
          description={
            hasOrg
              ? 'Requests appear here as soon as you start a service. You can also turn a saved scenario into a request.'
              : 'Create or join an organisation to request services.'
          }
          action={
            hasOrg ? (
              <Link
                href="/portal/requests/new"
                className="sx-touch inline-flex items-center rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary"
              >
                Start a request
              </Link>
            ) : (
              <Link
                href="/onboarding"
                className="sx-touch inline-flex items-center rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary"
              >
                Set up organisation
              </Link>
            )
          }
        />
      ) : (
        <DataTable
          caption="Service requests"
          rows={page.items}
          rowKey={(r) => r.id}
          rowLabel={(r) => `${r.reference} ${r.title}`}
          columns={[
            {
              key: 'reference',
              header: 'Reference',
              cell: (r) => (
                <Link
                  href={`/portal/requests/${r.id}`}
                  className="font-mono text-primary underline"
                >
                  {r.reference}
                </Link>
              ),
            },
            { key: 'title', header: 'Title', cell: (r) => r.title },
            { key: 'service', header: 'Service', cell: (r) => r.serviceName },
            { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            {
              key: 'market',
              header: 'Market',
              cell: (r) => r.marketName ?? '—',
              hideOnMobile: true,
            },
            { key: 'created', header: 'Created', cell: (r) => formatDateLabel(r.createdAt, zone) },
          ]}
        />
      )}
      {page.nextCursor ? (
        <Link
          href={`/portal/requests?${new URLSearchParams({ ...(status.success ? { status: status.data } : {}), cursor: page.nextCursor }).toString()}`}
          className="sx-touch inline-flex items-center rounded-md border border-border-strong px-4 text-sm"
        >
          Load older requests
        </Link>
      ) : null}
    </div>
  );
}
