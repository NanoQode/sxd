import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  StatusBadge,
  formatArea,
  formatDateLabel,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { customerCapabilities } from '@/lib/portal/server/permissions';
import { availabilityLabel, priceLabel, tenureLabel } from '@/components/public/listing-labels';
import { ListingOwnerActions } from '@/components/portal/listing-actions';
import { OfferSummaryRow } from '@/components/portal/listing-offer-panels';
import { ListingTransactionPanel } from '@/components/portal/listing-transaction-panel';
import { SectionTabs, resolveTab } from '@/components/portal/section-tabs';
import { listFilesForEntity } from '@/server/files/queries';
import { listOffersForListing } from '@/server/listings/offers';
import { getListingDetail, listListingMediaCandidates } from '@/server/listings/owner';
import { getListingTransaction } from '@/server/listings/transactions';

export const metadata: Metadata = { title: 'Listing' };
export const dynamic = 'force-dynamic';

const TABS = ['overview', 'offers', 'transaction'] as const;

export default async function ListingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: tabParam } = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  const identity = await requireSignedIn(`/portal/listings/${id}`);
  const listing = await getListingDetail(identity, id).catch((err) => {
    if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden'))
      return null;
    throw err;
  });
  if (!listing) notFound();
  const tab = resolveTab(tabParam, TABS);
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const caps = customerCapabilities(identity, listing.organizationId);
  const canManage = caps.can('org.listings.manage');
  const media = canManage ? await listListingMediaCandidates(identity, listing.organizationId) : [];
  const rev = listing.current;
  const isLive =
    listing.effectiveStatus === 'published' ||
    (listing.status === 'in_moderation' &&
      listing.publishedVersion !== null &&
      listing.effectiveStatus !== 'expired');

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/portal/listings" className="underline">
            Listings
          </Link>
        }
        title={listing.title}
        description={`${humanize(listing.kind)} · ${listing.propertyName ?? 'property'} · revision ${listing.currentVersion}${listing.publishedVersion !== null ? ` (published: ${listing.publishedVersion})` : ''}`}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={listing.effectiveStatus} />
            {listing.hasUnpublishedChanges ? <Badge tone="info">changes pending</Badge> : null}
            {isLive ? (
              <Link href={`/properties/${listing.slug}`} className="text-sm text-primary underline">
                View public page
              </Link>
            ) : null}
          </span>
        }
      />
      {listing.moderationNote ? (
        <Alert
          tone={listing.status === 'rejected' || listing.duplicateOfListingId ? 'danger' : 'info'}
          title="Note from moderation"
        >
          {listing.moderationNote}
        </Alert>
      ) : null}
      {listing.duplicateOfListingId ? (
        <Alert tone="warning" title="Marked as a duplicate">
          Staff recorded this listing as a duplicate
          {listing.duplicateOfSlug ? ` of ${listing.duplicateOfSlug}` : ''}. It is not shown
          publicly and cannot be resubmitted.
        </Alert>
      ) : null}
      <ListingOwnerActions listing={listing} canManage={canManage} media={media} />
      <SectionTabs
        basePath={`/portal/listings/${id}`}
        active={tab}
        label="Listing sections"
        tabs={[
          { value: 'overview', label: 'Overview' },
          {
            value: 'offers',
            label: 'Offers',
            badge:
              listing.offers.open > 0 ? (
                <Badge tone="warning">{listing.offers.open} open</Badge>
              ) : undefined,
          },
          { value: 'transaction', label: 'Transaction' },
        ]}
      />
      {tab === 'overview' ? (
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Current revision {rev.version}</CardTitle>
              <CardDescription>
                Saved {formatDateTimeLabel(rev.createdAt, zone)}.{' '}
                {listing.published && listing.published.version !== rev.version
                  ? `The public page shows revision ${listing.published.version}.`
                  : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                <div>
                  <dt className="text-fg-muted">Price</dt>
                  <dd className="font-medium">{priceLabel(rev)}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Area</dt>
                  <dd className="font-medium">{formatArea(rev.areaM2)}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Tenure</dt>
                  <dd className="font-medium">{tenureLabel(rev.tenure)}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Availability</dt>
                  <dd className="font-medium">{availabilityLabel(rev.availability)}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Public location precision</dt>
                  <dd className="font-medium">{humanize(rev.publicLocationPrecision)}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Shown until</dt>
                  <dd className="font-medium">
                    {listing.expiresAt ? formatDateLabel(listing.expiresAt, zone) : 'Not published'}
                  </dd>
                </div>
              </dl>
              <div>
                <p className="text-fg-muted">Title disclosure</p>
                <p className="whitespace-pre-wrap rounded-md bg-bg-sunken p-3">
                  {rev.titleDisclosure ?? 'Not stated.'}
                </p>
              </div>
              <div>
                <p className="text-fg-muted">Description</p>
                <p className="whitespace-pre-wrap rounded-md bg-bg-sunken p-3">
                  {rev.descriptionMarkdown ?? 'No description.'}
                </p>
              </div>
              <div>
                <p className="text-fg-muted">Photos ({listing.media.length})</p>
                {listing.media.length === 0 ? (
                  <p>No photos attached.</p>
                ) : (
                  <ul className="mt-1 list-disc pl-5">
                    {listing.media.map((m) => (
                      <li key={m.id}>
                        {m.originalName} ·{' '}
                        {m.isPublicApproved ? 'shown publicly' : 'awaiting public-use approval'}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Verification scope</CardTitle>
                <CardDescription>
                  Recorded by SimplexD staff; it is copied to every new revision and shown publicly
                  with dates and expiry.
                </CardDescription>
              </CardHeader>
              <CardContent className="text-sm">
                {rev.verification.checks.length === 0 ? (
                  <p className="text-fg-muted">No checks recorded yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {rev.verification.checks.map((c, i) => (
                      <li key={`${c.item}-${i}`}>
                        <span className="font-medium">{c.label}</span> ·{' '}
                        {c.outcome ? humanize(c.outcome) : 'recorded'} ·{' '}
                        {formatDateLabel(c.checkedAt, zone)}
                        {c.expiresAt ? ` · until ${formatDateLabel(c.expiresAt, zone)}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Owner authority</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {listing.ownerAuthority ? (
                  <p>
                    {listing.ownerAuthority.ownerName} ·{' '}
                    <StatusBadge status={listing.ownerAuthority.effectiveStatus} />
                    {listing.ownerAuthority.expiresAt
                      ? ` · valid until ${formatDateLabel(listing.ownerAuthority.expiresAt, zone)}`
                      : ''}
                  </p>
                ) : (
                  <p className="text-fg-muted">None submitted for this property.</p>
                )}
                <Link
                  href={`/portal/properties/${listing.propertyId}`}
                  className="mt-2 inline-block text-primary underline"
                >
                  Manage on the property page
                </Link>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Interest</CardTitle>
                <CardDescription>
                  Inquiries are qualified by SimplexD staff; contact details are not shared here.
                </CardDescription>
              </CardHeader>
              <CardContent className="text-sm">
                <p>
                  {listing.inquiries.total} inquir{listing.inquiries.total === 1 ? 'y' : 'ies'}
                  {listing.inquiries.lastAt
                    ? `, last ${formatDateTimeLabel(listing.inquiries.lastAt, zone)}`
                    : ''}
                  .
                </p>
                <p>
                  {listing.offers.total} offer{listing.offers.total === 1 ? '' : 's'} (
                  {listing.offers.open} open).
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Revisions</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                <ol className="space-y-1">
                  {listing.revisions.map((r) => (
                    <li key={r.version}>
                      v{r.version} · {r.title} · {formatDateTimeLabel(r.createdAt, zone)}
                      {r.version === listing.publishedVersion ? (
                        <Badge tone="success">published</Badge>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}
      {tab === 'offers' ? <OffersTab id={id} zone={zone} /> : null}
      {tab === 'transaction' ? (
        <TransactionTab listing={listing} canManage={canManage || caps.isStaff} zone={zone} />
      ) : null}
    </div>
  );
}

async function OffersTab({ id, zone }: { id: string; zone: string }) {
  const identity = await requireSignedIn(`/portal/listings/${id}`);
  const offers = await listOffersForListing(identity, id);
  if (offers.length === 0) {
    return (
      <EmptyState
        title="No offers yet"
        description="Offers from other organisations appear here with their negotiation log. You can counter, accept or decline each one."
      />
    );
  }
  return (
    <ul className="space-y-2">
      {offers.map((o) => (
        <OfferSummaryRow key={o.id} offer={o} zone={zone} />
      ))}
    </ul>
  );
}

async function TransactionTab({
  listing,
  canManage,
  zone,
}: {
  listing: Awaited<ReturnType<typeof getListingDetail>>;
  canManage: boolean;
  zone: string;
}) {
  const identity = await requireSignedIn(`/portal/listings/${listing.id}`);
  const [transaction, files] = await Promise.all([
    getListingTransaction(identity, listing.id),
    listFilesForEntity(identity, {
      entityType: 'property',
      entityId: listing.propertyId,
      limit: 100,
    })
      .then((p) => p.items)
      .catch(() => []),
  ]);
  return (
    <ListingTransactionPanel
      listing={listing}
      transaction={transaction}
      files={files}
      canManage={canManage}
      zone={zone}
    />
  );
}
