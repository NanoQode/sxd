import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { customerCapabilities, capabilityNote } from '@/lib/portal/server/permissions';
import { LinkButton } from '@/components/portal/link-button';
import { ListingForm } from '@/components/portal/listing-form';
import { listListableProperties, listListingMediaCandidates } from '@/server/listings/owner';

export const metadata: Metadata = { title: 'Create listing' };
export const dynamic = 'force-dynamic';

export default async function NewListingPage({
  searchParams,
}: {
  searchParams: Promise<{ propertyId?: string }>;
}) {
  const identity = await requireSignedIn('/portal/listings/new');
  const { propertyId } = await searchParams;
  const caps = customerCapabilities(identity);
  const organizationId = identity.ctx.organizationId;
  if (!organizationId || !caps.can('org.listings.manage')) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Create a listing"
          eyebrow={
            <Link href="/portal/listings" className="underline">
              Listings
            </Link>
          }
        />
        <EmptyState
          title="You cannot create listings"
          description={
            organizationId
              ? capabilityNote(caps, 'Creating listings')
              : 'Create or join an organisation first.'
          }
          action={
            <LinkButton
              href={organizationId ? '/portal/listings' : '/onboarding'}
              variant="secondary"
            >
              {organizationId ? 'Back to listings' : 'Set up an organisation'}
            </LinkButton>
          }
        />
      </div>
    );
  }
  const [properties, media] = await Promise.all([
    listListableProperties(identity),
    listListingMediaCandidates(identity, organizationId),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/portal/listings" className="underline">
            Listings
          </Link>
        }
        title="Create a listing"
        description="A draft you can edit until you submit it. Nothing is public before staff approve a revision."
      />
      {properties.length === 0 ? (
        <EmptyState
          title="No property to list"
          description="Add the land or property to your organisation first; the listing then references that private record."
          action={<LinkButton href="/portal/properties/new">Add a property</LinkButton>}
        />
      ) : (
        <ListingForm
          listing={null}
          properties={properties}
          media={media}
          defaultPropertyId={propertyId ?? null}
        />
      )}
    </div>
  );
}
