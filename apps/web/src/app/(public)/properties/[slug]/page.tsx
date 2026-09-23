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
  formatNairaString,
  humanize,
  type Column,
} from '@simplexd/ui';
import { getIdentity } from '@/lib/auth/session';
import { PageAction } from '@/components/public/action-bar';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { JsonLd, koboToNairaDecimal, listingJsonLd } from '@/components/public/json-ld';
import { Prose } from '@/components/public/section';
import { getPublishedListing, type VerificationCheck } from '@/server/listings/public';
import { absoluteUrl, publicMetadata, siteUrl } from '../../_lib/site-data';

type Params = Promise<{ slug: string }>;

async function load(slug: string) {
  const identity = await getIdentity();
  if (identity.featureFlags['core.public_listings'] === false) return null;
  try {
    return await getPublishedListing(slug);
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const listing = await load(slug);
  if (!listing) return { title: 'Listing not found', robots: { index: false, follow: false } };
  return publicMetadata({
    title: listing.title,
    description: `${humanize(listing.kind)} listing${listing.marketName ? ` in ${listing.marketName}` : ''}: ${listing.priceKobo ? formatNairaString(listing.priceKobo) : 'price on request'}, ${formatArea(listing.areaM2)}. Verification scope stated with dates and expiry.`,
    path: `/properties/${listing.slug}`,
  });
}

export default async function PropertyDetailPage({ params }: { params: Params }) {
  const { slug } = await params;
  const listing = await load(slug);
  if (!listing) notFound();
  const checks = listing.verification?.checks ?? [];
  const askHref = `/book?service=${listing.kind === 'sale' ? 'purchase-support' : 'property-search'}&listing=${listing.slug}`;

  const columns: Column<VerificationCheck>[] = [
    { key: 'item', header: 'What was checked', cell: (c) => c.item },
    { key: 'result', header: 'Result', cell: (c) => c.result },
    { key: 'by', header: 'Checked by', cell: (c) => c.checkedBy },
    { key: 'at', header: 'Checked on', cell: (c) => formatDateLabel(c.checkedAt) },
    {
      key: 'expires',
      header: 'Valid until',
      cell: (c) => (c.expiresAt ? formatDateLabel(c.expiresAt) : 'No expiry stated'),
    },
  ];

  return (
    <>
      <PageAction label="Ask about this listing" href={askHref} />
      <JsonLd
        data={listingJsonLd({
          name: listing.title,
          url: absoluteUrl(`/properties/${listing.slug}`),
          datePosted: listing.publishedAt,
          priceNairaDecimal: listing.priceKobo ? koboToNairaDecimal(listing.priceKobo) : null,
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
            {listing.marketName ? (
              <>
                {listing.marketSlug ? (
                  <Link
                    href={`/locations/${listing.marketSlug}`}
                    className="text-primary underline"
                  >
                    {listing.marketName}
                  </Link>
                ) : (
                  listing.marketName
                )}
                {listing.stateName ? `, ${listing.stateName}` : ''}
              </>
            ) : (
              'Location published at market level only'
            )}
          </p>
          <p className="mt-4 text-2xl font-semibold">
            {listing.priceKobo ? formatNairaString(listing.priceKobo) : 'Price on request'}
            {listing.priceBasis ? (
              <span className="text-base font-normal text-fg-muted"> · {listing.priceBasis}</span>
            ) : null}
          </p>

          <dl className="mt-6 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-fg-muted">Area</dt>
              <dd className="font-medium">{formatArea(listing.areaM2)}</dd>
            </div>
            <div>
              <dt className="text-fg-muted">Tenure</dt>
              <dd className="font-medium">{listing.tenure ?? 'Not stated'}</dd>
            </div>
            <div>
              <dt className="text-fg-muted">Title disclosure</dt>
              <dd className="font-medium">{listing.titleDisclosure ?? 'Not stated'}</dd>
            </div>
            <div>
              <dt className="text-fg-muted">Availability</dt>
              <dd className="font-medium">
                {listing.availability ?? 'Not stated'}
                {listing.availabilityConfirmedAt
                  ? ` (confirmed ${formatDateLabel(listing.availabilityConfirmedAt)})`
                  : ''}
              </dd>
            </div>
            <div>
              <dt className="text-fg-muted">Public location precision</dt>
              <dd className="font-medium">{humanize(listing.publicLocationPrecision)}</dd>
            </div>
            <div>
              <dt className="text-fg-muted">Published</dt>
              <dd className="font-medium">
                {listing.publishedAt ? formatDateLabel(listing.publishedAt) : '—'}
                {listing.expiresAt ? ` · expires ${formatDateLabel(listing.expiresAt)}` : ''}
              </dd>
            </div>
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
            <p className="mt-1 text-sm text-fg-muted">
              Only the checks listed here were performed. This is not a statement that the listing
              is legally verified in every respect.
            </p>
            {listing.verification?.summary ? (
              <p className="mt-2 text-sm">{listing.verification.summary}</p>
            ) : null}
            <div className="mt-3">
              <DataTable
                columns={columns}
                rows={checks}
                rowKey={(c) => `${c.item}-${c.checkedAt}`}
                rowLabel={(c) => c.item}
                caption={`Verification checks for ${listing.title}`}
                emptyMessage="No verification checks are recorded for this listing."
              />
            </div>
          </section>

          <section aria-labelledby="media-heading" className="mt-8">
            <h2 id="media-heading" className="text-xl font-semibold">
              Media
            </h2>
            <p className="mt-1 text-sm text-fg-muted">
              {listing.mediaCount > 0
                ? `${listing.mediaCount} approved file${listing.mediaCount === 1 ? '' : 's'} are attached. Public media derivatives are released through the portal once the media pipeline is configured.`
                : 'No approved media is attached to this listing.'}
            </p>
          </section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start" aria-label="Actions">
          <div className="rounded-lg border border-border bg-bg-elevated p-5">
            <h2 className="text-base font-semibold">Interested?</h2>
            <p className="mt-2 text-sm text-fg-muted">
              Ask about this listing and the team will confirm current availability and what a
              purchase or lease engagement would cover. Offers and diligence are run through the
              service pipeline, never by chat.
            </p>
            <Link href={askHref} className={`${buttonVariants({ size: 'lg' })} mt-4 w-full`}>
              Ask about this listing
            </Link>
            <Link
              href="/services/due-diligence"
              className={`${buttonVariants({ variant: 'secondary', size: 'lg' })} mt-2 w-full`}
            >
              Due diligence before you commit
            </Link>
          </div>
          <Alert tone="info" title="Precise location withheld">
            Coordinates and addresses are published only with the owner&apos;s approval. This
            listing is shown at {humanize(listing.publicLocationPrecision).toLowerCase()} precision.
          </Alert>
        </aside>
      </div>
    </>
  );
}
