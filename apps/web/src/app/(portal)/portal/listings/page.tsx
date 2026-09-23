import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, DataTable, EmptyState, PageHeader, StatusBadge, formatDateLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { customerCapabilities } from '@/lib/portal/server/permissions';
import { LinkButton } from '@/components/portal/link-button';
import { OfferSummaryRow } from '@/components/portal/listing-offer-panels';
import { SectionTabs, resolveTab } from '@/components/portal/section-tabs';
import { listMyListingOffers } from '@/server/listings/offers';
import { listListings } from '@/server/listings/owner';

export const metadata: Metadata = { title: 'Listings' };
export const dynamic = 'force-dynamic';

const TABS = ['listings', 'offers'] as const;

export default async function ListingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const identity = await requireSignedIn('/portal/listings');
  const { tab: tabParam } = await searchParams;
  const tab = resolveTab(tabParam, TABS);
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const caps = customerCapabilities(identity);
  const canManage = caps.can('org.listings.manage');
  const hasOrg = Boolean(identity.ctx.organizationId);
  const [listings, offers] = await Promise.all([
    hasOrg ? listListings(identity, { limit: 100 }) : Promise.resolve([]),
    hasOrg ? listMyListingOffers(identity, { side: 'all', limit: 100 }) : Promise.resolve([]),
  ]);
  const yourMove = offers.filter((o) => o.nextActions.length > 0).length;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Listings"
        description="Public listings of your land and property, moderated before publication, and the offers your organisation makes or receives."
        actions={canManage ? <LinkButton href="/portal/listings/new">Create a listing</LinkButton> : null}
      />
      <SectionTabs
        basePath="/portal/listings"
        active={tab}
        label="Listing sections"
        tabs={[
          { value: 'listings', label: 'Our listings', badge: listings.length > 0 ? <Badge tone="neutral">{listings.length}</Badge> : undefined },
          { value: 'offers', label: 'Offers', badge: yourMove > 0 ? <Badge tone="warning">{yourMove} to answer</Badge> : undefined },
        ]}
      />
      {!hasOrg ? (
        <EmptyState title="No active organisation" description="Create or join an organisation to list property or make offers." action={<LinkButton href="/onboarding">Set up an organisation</LinkButton>} />
      ) : tab === 'listings' ? (
        listings.length === 0 ? (
          <EmptyState
            title="No listings yet"
            description={
              canManage
                ? 'Create a draft from one of your properties. Submitting it for moderation needs a verified owner authority; staff then publish a specific revision with its verification scope.'
                : 'Listings are created by owners or members of this organisation.'
            }
            action={canManage ? <LinkButton href="/portal/listings/new">Create a listing</LinkButton> : undefined}
          />
        ) : (
          <DataTable
            caption="Listings"
            rows={listings}
            rowKey={(l) => l.id}
            rowLabel={(l) => l.title}
            columns={[
              {
                key: 'title',
                header: 'Listing',
                cell: (l) => (
                  <Link href={`/portal/listings/${l.id}`} className="font-medium text-primary underline">
                    {l.title}
                  </Link>
                ),
              },
              { key: 'property', header: 'Property', cell: (l) => l.propertyName ?? '—', hideOnMobile: true },
              { key: 'kind', header: 'Type', cell: (l) => humanize(l.kind) },
              {
                key: 'status',
                header: 'Status',
                cell: (l) => (
                  <span className="flex flex-wrap items-center gap-1">
                    <StatusBadge status={l.effectiveStatus} />
                    {l.hasUnpublishedChanges ? <Badge tone="info">changes pending</Badge> : null}
                  </span>
                ),
              },
              {
                key: 'expires',
                header: 'Shown until',
                cell: (l) => (l.expiresAt ? formatDateLabel(l.expiresAt, zone) : '—'),
                hideOnMobile: true,
              },
              { key: 'updated', header: 'Updated', cell: (l) => formatDateLabel(l.updatedAt, zone), hideOnMobile: true },
            ]}
          />
        )
      ) : offers.length === 0 ? (
        <EmptyState
          title="No offers"
          description="Offers you make on published listings, and offers other organisations make on yours, appear here with their negotiation log."
          action={<LinkButton href="/properties" variant="secondary">Browse published listings</LinkButton>}
        />
      ) : (
        <ul className="space-y-2">
          {offers.map((o) => (
            <OfferSummaryRow key={o.id} offer={o} zone={zone} />
          ))}
        </ul>
      )}
    </div>
  );
}
