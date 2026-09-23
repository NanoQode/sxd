import type { Metadata } from 'next';
import Link from 'next/link';
import { listingStatusSchema, type ListingListQuery } from '@simplexd/contracts';
import {
  Badge,
  DataTable,
  PageHeader,
  StatusBadge,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt, can, requireAnyStaff } from '@/lib/admin/server/context';
import { ApiAction } from '@/components/admin/api-action';
import { FilterBar, FilterInput, FilterSelect } from '@/components/admin/filter-bar';
import { LoadError } from '@/components/admin/load-error';
import { listListings } from '@/server/listings/owner';

export const metadata: Metadata = { title: 'Listings' };
export const dynamic = 'force-dynamic';

const VIEWS = [
  { value: 'queue', label: 'Awaiting decision' },
  { value: 'published', label: 'Published' },
  { value: 'expired', label: 'Expired' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'draft', label: 'Drafts' },
  { value: 'withdrawn', label: 'Withdrawn' },
  { value: 'archived', label: 'Closed' },
  { value: 'all', label: 'All' },
];

export default async function ListingsQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireSignedIn('/admin/listings');
  requireAnyStaff(identity, ['content.publish', 'rentals.manage', 'customers.read']);
  const raw = await searchParams;
  const view = raw.view ?? 'queue';
  const query: ListingListQuery = { limit: 100 };
  if (view === 'queue') query.queue = 'moderation';
  else if (listingStatusSchema.safeParse(view).success)
    query.status = view as ListingListQuery['status'];
  if (raw.q) query.q = raw.q;
  const loaded = await attempt(() => listListings(identity, query));
  if (!loaded.ok) return <LoadError code={loaded.code} message={loaded.message} what="Listings" />;
  const canRunExpiry = can(identity, 'rentals.manage') || can(identity, 'content.publish');
  return (
    <div className="space-y-6">
      <PageHeader
        title="Listings"
        description="Owner listings awaiting moderation, and everything published, expired, rejected or closed. Decisions need content.publish; verification checks need rentals.manage."
        actions={
          canRunExpiry ? (
            <ApiAction
              path="/api/v1/admin/listings/expiry-runs"
              label="Run expiry job now"
              confirm={{
                title: 'Run the expiry job?',
                description:
                  'Marks published listings whose 90-day availability window lapsed as expired and lapses open offers past their validity date. The hourly worker does the same.',
                confirmLabel: 'Run',
              }}
              successMessage="Expiry job ran"
            />
          ) : undefined
        }
      />
      <FilterBar>
        <FilterSelect
          name="view"
          label="View"
          value={view}
          options={VIEWS}
          allLabel="Awaiting decision"
        />
        <FilterInput name="q" label="Title or slug" value={raw.q} placeholder="Search" />
      </FilterBar>
      <DataTable
        caption="Listings"
        rows={loaded.value}
        rowKey={(l) => l.id}
        rowLabel={(l) => l.title}
        emptyMessage={
          view === 'queue' ? 'Nothing is waiting for a decision.' : 'No listings match.'
        }
        columns={[
          {
            key: 'title',
            header: 'Listing',
            cell: (l) => (
              <Link href={`/admin/listings/${l.id}`} className="font-medium underline">
                {l.title}
              </Link>
            ),
          },
          {
            key: 'org',
            header: 'Organisation',
            cell: (l) => l.organizationName ?? l.organizationId,
            hideOnMobile: true,
          },
          {
            key: 'kind',
            header: 'Type',
            cell: (l) => `${humanize(l.kind)} · ${l.propertyKind ? humanize(l.propertyKind) : '—'}`,
          },
          {
            key: 'status',
            header: 'Status',
            cell: (l) => (
              <span className="flex flex-wrap items-center gap-1">
                <StatusBadge status={l.effectiveStatus} />
                {l.publishedVersion !== null && l.status === 'in_moderation' ? (
                  <Badge tone="info">live; changes under review</Badge>
                ) : null}
                {l.duplicateOfListingId ? <Badge tone="warning">duplicate</Badge> : null}
              </span>
            ),
          },
          {
            key: 'rev',
            header: 'Revision',
            cell: (l) =>
              `v${l.currentVersion}${l.publishedVersion !== null ? ` (pub v${l.publishedVersion})` : ''}`,
            hideOnMobile: true,
          },
          {
            key: 'updated',
            header: 'Updated',
            cell: (l) => formatDateTimeLabel(l.updatedAt),
            hideOnMobile: true,
          },
        ]}
      />
    </div>
  );
}
