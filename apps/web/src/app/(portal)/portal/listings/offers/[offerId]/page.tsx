import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import { Alert, Card, CardContent, CardHeader, CardTitle, PageHeader, StatusBadge, formatDateTimeLabel, formatNairaString } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { ListingOfferActions, NegotiationLog } from '@/components/portal/listing-offer-panels';
import { getListingOffer } from '@/server/listings/offers';

export const metadata: Metadata = { title: 'Offer' };
export const dynamic = 'force-dynamic';

export default async function OfferDetailPage({ params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
  if (!uuidSchema.safeParse(offerId).success) notFound();
  const identity = await requireSignedIn(`/portal/listings/offers/${offerId}`);
  const offer = await getListingOffer(identity, offerId).catch((err) => {
    if (err instanceof ApiError && err.code === 'not_found') return null;
    throw err;
  });
  if (!offer) notFound();
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const counterpart = offer.viewerParty === 'buyer' ? offer.ownerOrganizationName ?? 'the owner' : offer.buyerOrganizationName ?? 'the buyer';
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<Link href="/portal/listings?tab=offers" className="underline">Offers</Link>}
        title={`${formatNairaString(offer.amountKobo)} on ${offer.listingTitle ?? 'a listing'}`}
        description={`${offer.viewerParty === 'buyer' ? 'Your offer to' : 'Offer from'} ${counterpart} · opened ${formatDateTimeLabel(offer.createdAt, zone)}`}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={offer.effectiveStatus} />
            {offer.listingSlug ? <Link href={`/properties/${offer.listingSlug}`} className="text-sm text-primary underline">View listing</Link> : null}
          </span>
        }
      />
      {offer.nextActions.length > 0 ? (
        <Alert tone="info" title="Your move">
          {offer.status === 'submitted' ? 'The buyer’s figure is on the table.' : 'The owner’s counter-offer is on the table.'}
          {offer.expiresAt ? ` This offer lapses ${formatDateTimeLabel(offer.expiresAt, zone)}.` : ''}
        </Alert>
      ) : null}
      <ListingOfferActions offer={offer} />
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Negotiation log</CardTitle>
          </CardHeader>
          <CardContent>
            <NegotiationLog offer={offer} zone={zone} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Terms</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Amount on the table: <strong>{formatNairaString(offer.amountKobo)}</strong></p>
            <p>Conditions:</p>
            {offer.conditions.length === 0 ? (
              <p className="text-fg-muted">None stated.</p>
            ) : (
              <ul className="list-disc pl-5">
                {offer.conditions.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
            {offer.decidedAt ? <p className="text-fg-muted">Decided {formatDateTimeLabel(offer.decidedAt, zone)}.</p> : null}
            <p className="text-fg-muted">
              Acceptance is not a contract. A sale or lease completes through the land sales/leasing engagement with documents.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
