import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { customerCapabilities, capabilityNote } from '@/lib/portal/server/permissions';
import { LinkButton } from '@/components/portal/link-button';
import { ListingOfferForm } from '@/components/portal/listing-offer-panels';
import { priceLabel } from '@/components/public/listing-labels';
import { getPublishedListing } from '@/server/listings/public';

export const metadata: Metadata = { title: 'Make an offer' };
export const dynamic = 'force-dynamic';

export default async function NewOfferPage({ searchParams }: { searchParams: Promise<{ listing?: string }> }) {
  const { listing: slug } = await searchParams;
  const identity = await requireSignedIn(`/portal/listings/offers/new${slug ? `?listing=${encodeURIComponent(slug)}` : ''}`);
  const caps = customerCapabilities(identity);
  const listing = slug ? await getPublishedListing(slug, { fresh: true }) : null;
  const eyebrow = <Link href="/portal/listings?tab=offers" className="underline">Offers</Link>;
  if (!listing) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={eyebrow} title="Make an offer" />
        <EmptyState title="Listing not available" description="Offers can only be made on published listings. Choose one from the public properties page." action={<LinkButton href="/properties" variant="secondary">Browse listings</LinkButton>} />
      </div>
    );
  }
  if (!identity.ctx.organizationId || !caps.can('org.requests.create')) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={eyebrow} title={`Offer on ${listing.title}`} />
        <EmptyState
          title="You cannot make offers"
          description={identity.ctx.organizationId ? capabilityNote(caps, 'Making offers') : 'Create or join an organisation first; offers belong to an organisation.'}
          action={<LinkButton href={identity.ctx.organizationId ? `/properties/${listing.slug}` : '/onboarding'} variant="secondary">{identity.ctx.organizationId ? 'Back to the listing' : 'Set up an organisation'}</LinkButton>}
        />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={eyebrow}
        title={`Offer on ${listing.title}`}
        description={`${priceLabel(listing)} · ${listing.location.marketName ?? listing.location.stateName ?? 'location at approved precision'}`}
        actions={<Link href={`/properties/${listing.slug}`} className="text-sm text-primary underline">View listing</Link>}
      />
      <ListingOfferForm listingId={listing.id} listingTitle={listing.title} statedPriceKobo={listing.priceKobo} />
    </div>
  );
}
