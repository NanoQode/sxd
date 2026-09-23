import type { Metadata } from 'next';
import Link from 'next/link';
import {
  LISTING_TENURE_LABELS,
  VERIFICATION_CHECK_LABELS,
  listingTenureSchema,
  type PublicListingDto,
} from '@simplexd/contracts';
import {
  Alert,
  Badge,
  buttonVariants,
  EmptyState,
  formatArea,
  humanize,
  PageHeader,
} from '@simplexd/ui';
import { getIdentity } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { CtaBand } from '@/components/public/cta-band';
import {
  availabilityLabel,
  locationLabel,
  priceLabel,
  tenureLabel,
} from '@/components/public/listing-labels';
import { hasActiveFilters, parseListingFilters } from '@/server/listings/filters';
import { listPublishedListings, locationOptions } from '@/server/listings/public';
import { isCheckCurrent } from '@/server/listings/rules';
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
const SORTS = [
  ['newest', 'Newest first'],
  ['price_asc', 'Price: low to high'],
  ['price_desc', 'Price: high to low'],
  ['area_desc', 'Largest area first'],
] as const;

function verificationSummary(l: PublicListingDto, now: Date): string {
  const checks = l.verification.checks;
  if (checks.length === 0) return 'No verification checks recorded';
  const current = checks.filter((c) => c.outcome === 'passed' && isCheckCurrent(c, now)).length;
  return `${current} current check${current === 1 ? '' : 's'} passed of ${checks.length} recorded`;
}

const field = 'h-11 w-full rounded-md border border-border-strong bg-bg-elevated px-3 text-sm';

export default async function PropertiesPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const { filters, ignored } = parseListingFilters(params);
  const identity = await getIdentity();
  const enabled = identity.featureFlags['core.public_listings'] !== false;
  const now = new Date();

  let listings: PublicListingDto[] | null = null;
  let allLive: PublicListingDto[] = [];
  if (enabled) {
    try {
      allLive = await listPublishedListings({}, { now });
      listings = await listPublishedListings(filters, { now });
    } catch (err) {
      logger().warn({ err: (err as Error).message }, 'public listings unavailable');
      listings = null;
    }
  }
  const places = locationOptions(allLive);
  const active = hasActiveFilters(filters);

  return (
    <>
      <Breadcrumbs items={[{ name: 'Properties', href: '/properties' }]} baseUrl={siteUrl()} />
      <div className="sx-container space-y-6 py-6">
        <PageHeader
          eyebrow="Properties"
          title="Published listings with their verification scope"
          description="Every listing states what was checked, by whom and when, with an expiry. Owner authority and content are moderated before publication; precise locations are withheld unless the owner asks and staff approve."
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
          className="grid gap-3 rounded-lg border border-border bg-bg-elevated p-4 sm:grid-cols-2 lg:grid-cols-4"
          aria-label="Filter listings"
        >
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="f-kind" className="font-medium">
              Listing type
            </label>
            <select id="f-kind" name="kind" defaultValue={filters.kind ?? ''} className={field}>
              <option value="">Any</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="f-type" className="font-medium">
              Property type
            </label>
            <select id="f-type" name="type" defaultValue={filters.type ?? ''} className={field}>
              <option value="">Any</option>
              {PROPERTY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="f-min-price" className="font-medium">
              Minimum price (₦)
            </label>
            <input
              id="f-min-price"
              name="minPrice"
              inputMode="numeric"
              defaultValue={filters.minPrice ?? ''}
              className={field}
              placeholder="e.g. 5,000,000"
            />
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="f-max-price" className="font-medium">
              Maximum price (₦)
            </label>
            <input
              id="f-max-price"
              name="maxPrice"
              inputMode="numeric"
              defaultValue={filters.maxPrice ?? ''}
              className={field}
              placeholder="e.g. 50,000,000"
            />
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="f-min-area" className="font-medium">
              Minimum area (m²)
            </label>
            <input
              id="f-min-area"
              name="minArea"
              inputMode="decimal"
              defaultValue={filters.minArea ?? ''}
              className={field}
            />
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="f-max-area" className="font-medium">
              Maximum area (m²)
            </label>
            <input
              id="f-max-area"
              name="maxArea"
              inputMode="decimal"
              defaultValue={filters.maxArea ?? ''}
              className={field}
            />
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="f-state" className="font-medium">
              State
            </label>
            <select id="f-state" name="state" defaultValue={filters.state ?? ''} className={field}>
              <option value="">Any state</option>
              {places.states.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="f-market" className="font-medium">
              Market
            </label>
            <select id="f-market" name="market" defaultValue={filters.market ?? ''} className={field}>
              <option value="">Any market</option>
              {places.markets.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="f-tenure" className="font-medium">
              Tenure
            </label>
            <select id="f-tenure" name="tenure" defaultValue={filters.tenure ?? ''} className={field}>
              <option value="">Any tenure</option>
              {listingTenureSchema.options.map((t) => (
                <option key={t} value={t}>
                  {LISTING_TENURE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="f-check" className="font-medium">
              Verification check passed
            </label>
            <select id="f-check" name="check" defaultValue={filters.check ?? ''} className={field}>
              <option value="">Any</option>
              {(Object.keys(VERIFICATION_CHECK_LABELS) as Array<keyof typeof VERIFICATION_CHECK_LABELS>).map(
                (k) => (
                  <option key={k} value={k}>
                    {VERIFICATION_CHECK_LABELS[k]}
                  </option>
                ),
              )}
            </select>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="f-sort" className="font-medium">
              Sort by
            </label>
            <select id="f-sort" name="sort" defaultValue={filters.sort} className={field}>
              {SORTS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="font-medium">Only show</legend>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="title"
                value="disclosed"
                defaultChecked={filters.title === 'disclosed'}
                className="h-4 w-4"
              />
              Title disclosure stated
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="available"
                value="now"
                defaultChecked={filters.available === 'now'}
                className="h-4 w-4"
              />
              Available now
            </label>
          </fieldset>
          <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
            <button type="submit" className={buttonVariants({ variant: 'primary' })}>
              Apply filters
            </button>
            {active ? (
              <Link href="/properties" className={buttonVariants({ variant: 'ghost' })}>
                Clear filters
              </Link>
            ) : null}
            <p className="text-xs text-fg-subtle">
              Prices are compared as stated, on the basis each listing gives (outright, per year,
              per plot…). Listings with no stated price are left out of price ranges.
            </p>
          </div>
        </form>

        {ignored.length > 0 ? (
          <Alert tone="warning" title="Some filters were ignored">
            These values were not understood and were not applied: {ignored.join(', ')}.
          </Alert>
        ) : null}

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
            title={active ? 'No listings match these filters' : 'No published listings yet'}
            description={
              active
                ? 'Widen the price or area range, or clear the filters. Listings with no stated price never match a price range.'
                : 'Listings appear after owner authority is verified and the content is moderated. Ask the team about land or property you are looking for.'
            }
            action={
              active ? (
                <Link href="/properties" className={buttonVariants({ size: 'sm' })}>
                  Clear filters
                </Link>
              ) : (
                <Link href="/book?service=property-search" className={buttonVariants({ size: 'sm' })}>
                  Request a property search
                </Link>
              )
            }
          />
        ) : (
          <>
            <p className="text-sm text-fg-muted" role="status">
              {listings.length} listing{listings.length === 1 ? '' : 's'}
              {active ? ' match the filters' : ' published'}.
            </p>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {listings.map((l) => (
                <li
                  key={l.id}
                  className="relative flex flex-col rounded-lg border border-border bg-bg-elevated p-4 shadow-sm"
                >
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone="primary">{humanize(l.kind)}</Badge>
                    <Badge tone="neutral">{humanize(l.propertyKind)}</Badge>
                    {l.media.length > 0 ? (
                      <Badge tone="neutral">
                        {l.media.length} photo{l.media.length === 1 ? '' : 's'}
                      </Badge>
                    ) : null}
                  </div>
                  <h2 className="mt-2 text-base font-semibold leading-tight">
                    <Link
                      href={`/properties/${l.slug}`}
                      className="after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {l.title}
                    </Link>
                  </h2>
                  <p className="text-sm text-fg-muted">{locationLabel(l.location)}</p>
                  <p className="mt-2 text-lg font-semibold">{priceLabel(l)}</p>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-fg-muted">
                    <dt>Area</dt>
                    <dd className="text-fg">{formatArea(l.areaM2)}</dd>
                    <dt>Tenure</dt>
                    <dd className="text-fg">{tenureLabel(l.tenure)}</dd>
                    <dt>Title</dt>
                    <dd className="text-fg">
                      {l.titleDisclosure ? 'Disclosure stated' : 'No disclosure stated'}
                    </dd>
                    <dt>Availability</dt>
                    <dd className="text-fg">{availabilityLabel(l.availability)}</dd>
                    <dt>Verification</dt>
                    <dd className="text-fg">{verificationSummary(l, now)}</dd>
                  </dl>
                </li>
              ))}
            </ul>
          </>
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
