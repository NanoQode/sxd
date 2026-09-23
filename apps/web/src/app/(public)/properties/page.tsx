import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Badge,
  buttonVariants,
  EmptyState,
  formatArea,
  formatDateLabel,
  formatNairaString,
  humanize,
  PageHeader,
} from '@simplexd/ui';
import { getIdentity } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { CtaBand } from '@/components/public/cta-band';
import { listPublishedListings, type PublicListing } from '@/server/listings/public';
import { publicMetadata, siteUrl, type SearchParams } from '../_lib/site-data';

export const metadata: Metadata = publicMetadata({
  title: 'Properties',
  description:
    'Published land and property listings with verification-scope details: what was checked, by whom, when and until when. No listing is implied to be legally verified.',
  path: '/properties',
});

const KINDS = ['sale', 'lease', 'short_stay'] as const;
const PROPERTY_KINDS = [
  'land',
  'residential',
  'commercial',
  'industrial',
  'mixed_use',
  'student_housing',
  'short_stay',
] as const;

function verificationSummary(l: PublicListing): { text: string; expiry: string | null } {
  const checks = l.verification?.checks ?? [];
  if (checks.length === 0) return { text: 'No verification checks recorded', expiry: null };
  const expiries = checks
    .map((c) => c.expiresAt)
    .filter((e): e is string => Boolean(e))
    .sort();
  return {
    text: `${checks.length} check${checks.length === 1 ? '' : 's'} recorded`,
    expiry: expiries[0] ?? null,
  };
}

export default async function PropertiesPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const kindParam =
    typeof params.kind === 'string' && (KINDS as readonly string[]).includes(params.kind)
      ? (params.kind as (typeof KINDS)[number])
      : undefined;
  const typeParam =
    typeof params.type === 'string' && (PROPERTY_KINDS as readonly string[]).includes(params.type)
      ? params.type
      : undefined;
  const identity = await getIdentity();
  const enabled = identity.featureFlags['core.public_listings'] !== false;

  let listings: PublicListing[] | null = null;
  if (enabled) {
    try {
      listings = await listPublishedListings({ kind: kindParam, propertyKind: typeParam });
    } catch (err) {
      logger().warn({ err: (err as Error).message }, 'public listings unavailable');
      listings = null;
    }
  }

  return (
    <>
      <Breadcrumbs items={[{ name: 'Properties', href: '/properties' }]} baseUrl={siteUrl()} />
      <div className="sx-container space-y-6 py-6">
        <PageHeader
          eyebrow="Properties"
          title="Published listings with their verification scope"
          description="Every listing states what was checked, by whom and when, with an expiry. Owner authority and content are moderated before publication; precise locations are withheld unless the owner approves."
          actions={
            <Link
              href="/services/land-sales-leasing"
              className={buttonVariants({ variant: 'secondary' })}
            >
              List land or property
            </Link>
          }
        />

        <form
          method="get"
          action="/properties"
          className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-bg-elevated p-4"
          aria-label="Filter listings"
        >
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="filter-kind" className="font-medium">
              Listing type
            </label>
            <select
              id="filter-kind"
              name="kind"
              defaultValue={kindParam ?? ''}
              className="h-11 rounded-md border border-border-strong bg-bg-elevated px-3"
            >
              <option value="">Any</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="filter-type" className="font-medium">
              Property type
            </label>
            <select
              id="filter-type"
              name="type"
              defaultValue={typeParam ?? ''}
              className="h-11 rounded-md border border-border-strong bg-bg-elevated px-3"
            >
              <option value="">Any</option>
              {PROPERTY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className={buttonVariants({ variant: 'secondary' })}>
            Apply filters
          </button>
          {kindParam || typeParam ? (
            <Link href="/properties" className="text-sm text-primary underline">
              Clear
            </Link>
          ) : null}
        </form>

        {!enabled ? (
          <EmptyState
            title="Public listings are switched off"
            description="The core.public_listings feature flag is disabled. Listings remain in the customer portal and will appear here when the flag is enabled."
          />
        ) : listings === null ? (
          <EmptyState
            tone="warning"
            title="Listings are not available right now"
            description="The database did not respond. Nothing is shown in place of real listings."
          />
        ) : listings.length === 0 ? (
          <EmptyState
            title="No published listings yet"
            description="Listings appear after owner authority is verified and the content is moderated. Ask the team about land or property you are looking for."
            action={
              <Link href="/book?service=property-search" className={buttonVariants({ size: 'sm' })}>
                Request a property search
              </Link>
            }
          />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {listings.map((l) => {
              const v = verificationSummary(l);
              return (
                <li
                  key={l.id}
                  className="relative flex flex-col rounded-lg border border-border bg-bg-elevated p-4 shadow-sm"
                >
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone="primary">{humanize(l.kind)}</Badge>
                    <Badge tone="neutral">{humanize(l.propertyKind)}</Badge>
                  </div>
                  <h2 className="mt-2 text-base font-semibold leading-tight">
                    <Link
                      href={`/properties/${l.slug}`}
                      className="after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {l.title}
                    </Link>
                  </h2>
                  <p className="text-sm text-fg-muted">
                    {l.marketName
                      ? `${l.marketName}${l.stateName ? `, ${l.stateName}` : ''}`
                      : 'Location published at market level only'}
                  </p>
                  <p className="mt-2 text-lg font-semibold">
                    {l.priceKobo ? formatNairaString(l.priceKobo) : 'Price on request'}
                    {l.priceBasis ? (
                      <span className="text-sm font-normal text-fg-muted"> · {l.priceBasis}</span>
                    ) : null}
                  </p>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-fg-muted">
                    <dt>Area</dt>
                    <dd className="text-fg">{formatArea(l.areaM2)}</dd>
                    <dt>Tenure</dt>
                    <dd className="text-fg">{l.tenure ?? 'Not stated'}</dd>
                    <dt>Availability</dt>
                    <dd className="text-fg">
                      {l.availability ?? 'Not stated'}
                      {l.availabilityConfirmedAt
                        ? ` (confirmed ${formatDateLabel(l.availabilityConfirmedAt)})`
                        : ''}
                    </dd>
                    <dt>Verification</dt>
                    <dd className="text-fg">
                      {v.text}
                      {v.expiry ? `, earliest expiry ${formatDateLabel(v.expiry)}` : ''}
                    </dd>
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-fg-subtle">
          A verification badge describes specific checks with a date and expiry; it never implies
          that a listing is legally verified in every respect.
        </p>
      </div>
      <CtaBand
        title="Looking for something specific?"
        description="A property search engagement captures your requirements and returns a compared shortlist with viewing bookings."
        primary={{ label: 'Request a property search', href: '/book?service=property-search' }}
        secondary={{ label: 'Explore locations', href: '/explore' }}
      />
    </>
  );
}
