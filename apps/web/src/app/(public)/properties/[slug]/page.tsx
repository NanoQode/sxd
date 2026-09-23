import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Alert,
  Badge,
  buttonVariants,
  DataTable,
  formatArea,
  formatDateLabel,
  formatDateTimeLabel,
  formatNairaString,
  humanize,
  type Column,
} from '@simplexd/ui';
import { getIdentity } from '@/lib/auth/session';
import { PageAction } from '@/components/public/action-bar';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { JsonLd, koboToNairaDecimal, listingJsonLd } from '@/components/public/json-ld';
import { ListingInquiryForm } from '@/components/public/listing-inquiry-form';
import {
  availabilityLabel,
  locationLabel,
  PRECISION_COPY,
  priceLabel,
  tenureLabel,
} from '@/components/public/listing-labels';
import { Prose } from '@/components/public/section';
import {
  getPublicListingState,
  type PublicListingState,
  type VerificationCheck,
} from '@/server/listings/public';
import { isCheckCurrent } from '@/server/listings/rules';
import { absoluteUrl, publicMetadata, siteUrl } from '../../_lib/site-data';

type Params = Promise<{ slug: string }>;

async function load(slug: string): Promise<PublicListingState> {
  const identity = await getIdentity();
  if (identity.featureFlags['core.public_listings'] === false) return { state: 'not_found' };
  try {
    return await getPublicListingState(slug);
  } catch {
    return { state: 'not_found' };
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const state = await load(slug);
  if (state.state === 'not_found') {
    return { title: 'Listing not found', robots: { index: false, follow: false } };
  }
  if (state.state === 'unavailable') {
    return {
      title: `${state.title} (no longer available)`,
      robots: { index: false, follow: true },
      alternates: {
        canonical: state.canonicalSlug
          ? `/properties/${state.canonicalSlug}`
          : `/properties/${slug}`,
      },
    };
  }
  const listing = state.listing;
  return publicMetadata({
    title: listing.title,
    description: `${humanize(listing.kind)} listing${listing.location.marketName ? ` in ${listing.location.marketName}` : ''}: ${priceLabel(listing)}, ${formatArea(listing.areaM2)}. Verification scope stated with dates and expiry.`,
    path: `/properties/${listing.slug}`,
  });
}

const UNAVAILABLE_COPY = {
  expired: 'The owner has not re-confirmed availability, so the listing is paused until they do.',
  duplicate: 'This listing duplicated another one.',
  withdrawn: 'The owner withdrew this listing.',
  closed: 'The transaction on this listing has been documented and the listing is closed.',
} as const;

export default async function PropertyDetailPage({ params }: { params: Params }) {
  const { slug } = await params;
  const state = await load(slug);
  if (state.state === 'not_found') notFound();

  if (state.state === 'unavailable') {
    return (
      <>
        <Breadcrumbs
          items={[
            { name: 'Properties', href: '/properties' },
            { name: state.title, href: `/properties/${slug}` },
          ]}
          baseUrl={siteUrl()}
        />
        <div className="sx-container space-y-6 py-10">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="neutral">{humanize(state.kind)}</Badge>
            <Badge tone="warning">No longer available</Badge>
          </div>
          <h1 className="font-display text-2xl font-semibold leading-tight sm:text-3xl">
            {state.title}
          </h1>
          <p className="max-w-prose text-fg-muted">
            {UNAVAILABLE_COPY[state.reason]} Prices, documents and inquiries are not shown for
            listings that are not live.
          </p>
          <div className="flex flex-wrap gap-2">
            {state.canonicalSlug ? (
              <Link href={`/properties/${state.canonicalSlug}`} className={buttonVariants()}>
                See the original listing
              </Link>
            ) : null}
            <Link href="/properties" className={buttonVariants({ variant: 'secondary' })}>
              Browse published listings
            </Link>
            <Link
              href="/book?service=property-search"
              className={buttonVariants({ variant: 'ghost' })}
            >
              Request a property search
            </Link>
          </div>
        </div>
      </>
    );
  }

  const listing = state.listing;
  const identity = await getIdentity();
  const now = new Date();
  const checks = listing.verification.checks;
  const canOffer = listing.kind !== 'short_stay';
  const offerHref = identity.session
    ? `/portal/listings/offers/new?listing=${listing.slug}`
    : `/sign-in?next=${encodeURIComponent(`/portal/listings/offers/new?listing=${listing.slug}`)}`;
  const images = listing.media.map((m) => ({
    ...m,
    web: `/api/v1/public/listings/${listing.slug}/media/${m.fileId}?variant=web`,
    thumb: `/api/v1/public/listings/${listing.slug}/media/${m.fileId}?variant=thumb`,
  }));

  const columns: Column<VerificationCheck>[] = [
    { key: 'item', header: 'What was checked', cell: (c) => c.label },
    {
      key: 'outcome',
      header: 'Outcome',
      cell: (c) => (
        <Badge
          tone={
            c.outcome === 'passed' ? 'success' : c.outcome === 'issue_found' ? 'danger' : 'warning'
          }
        >
          {c.outcome ? humanize(c.outcome) : 'Recorded'}
        </Badge>
      ),
    },
    { key: 'result', header: 'What was found', cell: (c) => c.result },
    { key: 'by', header: 'Checked by', cell: (c) => c.checkedBy },
    { key: 'at', header: 'Checked on', cell: (c) => formatDateLabel(c.checkedAt) },
    {
      key: 'expires',
      header: 'Valid until',
      cell: (c) =>
        c.expiresAt
          ? `${formatDateLabel(c.expiresAt)}${isCheckCurrent(c, now) ? '' : ' (expired)'}`
          : 'No expiry stated',
    },
  ];

  return (
    <>
      <PageAction label="Ask about this listing" href="#inquiry" />
      <JsonLd
        data={listingJsonLd({
          name: listing.title,
          url: absoluteUrl(`/properties/${listing.slug}`),
          datePosted: listing.publishedAt,
          validThrough: listing.expiresAt,
          priceNairaDecimal: listing.priceKobo ? koboToNairaDecimal(listing.priceKobo) : null,
          addressRegion: listing.location.stateName,
          addressLocality: listing.location.marketName,
          geo: listing.location.point,
          images: images.map((i) => absoluteUrl(i.web)),
        })}
      />
      <Breadcrumbs
        items={[
          { name: 'Properties', href: '/properties' },
          { name: listing.title, href: `/properties/${listing.slug}` },
        ]}
        baseUrl={siteUrl()}
      />
      <div className="sx-container grid gap-8 py-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="primary">{humanize(listing.kind)}</Badge>
            <Badge tone="neutral">{humanize(listing.propertyKind)}</Badge>
          </div>
          <h1 className="font-display mt-2 text-2xl font-semibold leading-tight sm:text-3xl">
            {listing.title}
          </h1>
          <p className="mt-1 text-fg-muted">
            {listing.location.marketSlug && listing.location.marketName ? (
              <>
                {listing.location.neighborhoodName ? `${listing.location.neighborhoodName}, ` : ''}
                <Link
                  href={`/locations/${listing.location.marketSlug}`}
                  className="text-primary underline"
                >
                  {listing.location.marketName}
                </Link>
                {listing.location.stateName ? `, ${listing.location.stateName}` : ''}
              </>
            ) : (
              locationLabel(listing.location)
            )}
          </p>
          <p className="mt-4 text-2xl font-semibold">{priceLabel(listing)}</p>

          {images.length > 0 ? (
            <ul className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Listing photos">
              {images.map((img) => (
                <li key={img.fileId}>
                  <a
                    href={img.web}
                    className="block overflow-hidden rounded-md border border-border"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived derivative URLs */}
                    <img
                      src={img.thumb}
                      alt={img.altText}
                      loading="lazy"
                      className="aspect-[4/3] w-full object-cover"
                    />
                  </a>
                  {img.caption ? <p className="mt-1 text-xs text-fg-muted">{img.caption}</p> : null}
                </li>
              ))}
            </ul>
          ) : null}

          <dl className="mt-6 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-fg-muted">Area</dt>
              <dd className="font-medium">{formatArea(listing.areaM2)}</dd>
            </div>
            <div>
              <dt className="text-fg-muted">Tenure</dt>
              <dd className="font-medium">{tenureLabel(listing.tenure)}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-fg-muted">Title disclosure (as stated by the owner)</dt>
              <dd className="font-medium whitespace-pre-wrap">
                {listing.titleDisclosure ?? 'Not stated'}
              </dd>
            </div>
            <div>
              <dt className="text-fg-muted">Availability</dt>
              <dd className="font-medium">
                {availabilityLabel(listing.availability)}
                {listing.availabilityConfirmedAt
                  ? ` (confirmed by the owner ${formatDateLabel(listing.availabilityConfirmedAt)})`
                  : ''}
              </dd>
            </div>
            <div>
              <dt className="text-fg-muted">Published</dt>
              <dd className="font-medium">
                {listing.publishedAt ? formatDateLabel(listing.publishedAt) : '—'}
                {listing.expiresAt ? ` · shown until ${formatDateLabel(listing.expiresAt)}` : ''}
              </dd>
            </div>
            {listing.location.point ? (
              <div className="sm:col-span-2">
                <dt className="text-fg-muted">Coordinates (approved for publication)</dt>
                <dd className="font-medium">
                  {listing.location.point.lat.toFixed(5)}, {listing.location.point.lon.toFixed(5)}
                </dd>
              </div>
            ) : null}
          </dl>

          {listing.descriptionHtml ? (
            <section aria-labelledby="description-heading" className="mt-8">
              <h2 id="description-heading" className="text-xl font-semibold">
                Description
              </h2>
              <Prose html={listing.descriptionHtml} className="mt-2" />
            </section>
          ) : null}

          <section aria-labelledby="verification-heading" className="mt-8">
            <h2 id="verification-heading" className="text-xl font-semibold">
              Verification scope
            </h2>
            <Alert tone="info" title="Not a legal verification" className="mt-2">
              Only the checks listed here were performed, on the dates shown, and each lapses at its
              expiry. This panel is not a statement that the listing is legally verified; commission
              due diligence before you commit.
            </Alert>
            {listing.verification.summary ? (
              <p className="mt-3 text-sm">{listing.verification.summary}</p>
            ) : null}
            <div className="mt-3">
              <DataTable
                columns={columns}
                rows={checks}
                rowKey={(c) => `${c.item}-${c.checkedAt}`}
                rowLabel={(c) => c.label}
                caption={`Verification checks for ${listing.title}`}
                emptyMessage="No verification checks are recorded for this listing."
              />
            </div>
          </section>
        </div>

        <aside
          className="space-y-4 lg:sticky lg:top-24 lg:self-start"
          aria-label="Inquiries and offers"
        >
          <section id="inquiry" className="rounded-lg border border-border bg-bg-elevated p-5">
            <h2 className="text-base font-semibold">Ask about this listing</h2>
            <div className="mt-3">
              <ListingInquiryForm slug={listing.slug} title={listing.title} />
            </div>
          </section>
          {canOffer ? (
            <div className="rounded-lg border border-border bg-bg-elevated p-5">
              <h2 className="text-base font-semibold">Make an offer</h2>
              <p className="mt-2 text-sm text-fg-muted">
                Offers are made from a customer account and negotiated with the owner in an
                append-only log.{' '}
                {listing.priceKobo
                  ? `The stated price is ${formatNairaString(listing.priceKobo)}.`
                  : 'No price is stated; propose one.'}
              </p>
              <Link
                href={offerHref}
                className={`${buttonVariants({ variant: 'secondary', size: 'lg' })} mt-4 w-full`}
              >
                {identity.session ? 'Make an offer' : 'Sign in to make an offer'}
              </Link>
              <Link
                href="/services/due-diligence"
                className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} mt-2 w-full`}
              >
                Due diligence before you commit
              </Link>
            </div>
          ) : null}
          <Alert
            tone="info"
            title={`Location shown at ${humanize(listing.location.precision).toLowerCase()} precision`}
          >
            {PRECISION_COPY[listing.location.precision]}
          </Alert>
          <p className="text-xs text-fg-subtle">
            Page generated {formatDateTimeLabel(now)}. Listings leave this site when the owner’s
            availability confirmation lapses.
          </p>
        </aside>
      </div>
    </>
  );
}
