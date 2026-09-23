import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { MarketDetailDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  buttonVariants,
  DataTable,
  EmptyState,
  EvidenceBadge,
  formatDateLabel,
  formatNairaString,
  humanize,
  type Column,
} from '@simplexd/ui';
import { renderMarkdown } from '@/lib/markdown';
import { PageAction } from '@/components/public/action-bar';
import { AvailabilityBadge, recommendationLabel } from '@/components/public/availability-badge';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { JsonLd, placeJsonLd } from '@/components/public/json-ld';
import { ZONE_NAMES } from '@/components/public/market-card';
import { ObservationTable } from '@/components/public/observation-table';
import { Prose } from '@/components/public/section';
import { absoluteUrl, loadLocationIntro, loadMarket, siteUrl } from '../../_lib/site-data';
import { locationMetadata } from './metadata';

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const [result, intro] = await Promise.all([loadMarket(slug), loadLocationIntro(slug)]);
  return locationMetadata({ slug, result, intro });
}

type SupplierLead = MarketDetailDto['supplierLeads'][number];
type SupplierQuote = MarketDetailDto['supplierQuotes'][number];

export default async function LocationDetailPage({ params }: { params: Params }) {
  const { slug } = await params;
  const [result, intro] = await Promise.all([loadMarket(slug), loadLocationIntro(slug)]);
  if (result.status === 'missing') notFound();
  const base = siteUrl();

  if (result.status === 'unavailable') {
    return (
      <>
        <Breadcrumbs
          items={[
            { name: 'Locations', href: '/locations' },
            { name: slug, href: `/locations/${slug}` },
          ]}
          baseUrl={base}
        />
        <div className="sx-container py-10">
          <EmptyState
            tone="warning"
            title="Location data is not available yet"
            description="The market read model did not respond, so this page cannot show evidence, coverage or map position. Nothing is estimated in its place."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link
                  href="/locations"
                  className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                >
                  All locations
                </Link>
                <Link href={`/book?market=${slug}`} className={buttonVariants({ size: 'sm' })}>
                  Ask about this location
                </Link>
              </div>
            }
          />
        </div>
      </>
    );
  }

  const m = result.market;
  const stateLabel = `${m.stateName}${m.isFederalCapital ? ' (FCT)' : ' State'}`;
  const bookHref = `/book?market=${m.slug}&marketId=${m.id}`;
  const compareHref = `/explore?market=${m.slug}&compare=1`;
  const activeFlags = m.flags.filter((f) => f.active);
  const publishedNeighborhoods = m.neighborhoods.filter((n) => n.publicationState === 'published');
  const openTasks = m.researchTasks.filter((t) => t.status !== 'done');

  const leadColumns: Column<SupplierLead>[] = [
    {
      key: 'name',
      header: 'Facility',
      cell: (l) => (
        <div>
          <p className="font-medium">{l.name}</p>
          {l.operator ? <p className="text-xs text-fg-muted">{l.operator}</p> : null}
        </div>
      ),
    },
    { key: 'material', header: 'Material', cell: (l) => humanize(l.material) },
    { key: 'state', header: 'State', cell: (l) => l.stateName ?? 'Unknown' },
    { key: 'evidence', header: 'Evidence status', cell: (l) => humanize(l.evidenceStatus) },
    { key: 'relation', header: 'Relation to this market', cell: (l) => humanize(l.relation) },
    {
      key: 'delivery',
      header: 'Delivery coverage verified',
      cell: (l) => (l.deliveryCoverageVerified ? 'Yes' : 'No'),
    },
    { key: 'stock', header: 'Stock', cell: (l) => humanize(l.stockStatus) },
    {
      key: 'badge',
      header: 'Badge',
      cell: (l) => (
        <div className="space-y-1">
          <EvidenceBadge kind={l.badge} />
          {l.source?.url ? (
            <a
              href={l.source.url}
              rel="noopener noreferrer"
              target="_blank"
              className="block text-xs text-primary underline"
            >
              {l.source.title}
            </a>
          ) : l.source ? (
            <span className="block text-xs text-fg-muted">{l.source.title}</span>
          ) : null}
        </div>
      ),
    },
  ];

  const quoteColumns: Column<SupplierQuote>[] = [
    {
      key: 'material',
      header: 'Material',
      cell: (q) => `${humanize(q.material)} · ${q.specification}`,
    },
    { key: 'unit', header: 'Unit', cell: (q) => q.unit },
    {
      key: 'price',
      header: 'Unit price',
      cell: (q) => (q.unitPrice ? formatNairaString(q.unitPrice.amountKobo) : 'Not stated'),
    },
    {
      key: 'delivery',
      header: 'Delivery',
      cell: (q) => (q.deliveryCost ? formatNairaString(q.deliveryCost.amountKobo) : 'Not stated'),
    },
    {
      key: 'lead',
      header: 'Lead time',
      cell: (q) => (q.leadTimeDays === null ? 'Not stated' : `${q.leadTimeDays} days`),
    },
    {
      key: 'dates',
      header: 'Quoted / valid until',
      cell: (q) =>
        `${formatDateLabel(q.quotedAt)} / ${q.validUntil ? formatDateLabel(q.validUntil) : 'not stated'}`,
    },
    {
      key: 'badge',
      header: 'Badge',
      cell: (q) => (
        <div className="flex flex-wrap gap-1">
          <EvidenceBadge kind={q.badge} />
          {q.freshness === 'stale' ? <Badge tone="warning">Stale</Badge> : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageAction
        label={`Book about ${m.name}`}
        href={bookHref}
        secondary={{ label: 'Compare', href: compareHref }}
      />
      <JsonLd
        data={placeJsonLd({
          name: m.name,
          url: absoluteUrl(`/locations/${m.slug}`),
          lat: m.location.lat,
          lon: m.location.lon,
          stateName: m.stateName,
        })}
      />
      <Breadcrumbs
        items={[
          { name: 'Locations', href: '/locations' },
          { name: m.name, href: `/locations/${m.slug}` },
        ]}
        baseUrl={base}
      />
      <div className="sx-container py-6">
        <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">
          {stateLabel} · {ZONE_NAMES[m.geopoliticalZone]}
        </p>
        <h1 className="font-display mt-1 text-3xl font-semibold leading-tight sm:text-4xl">
          {m.name}
        </h1>
        {m.aliases.length > 0 ? (
          <p className="mt-1 text-sm text-fg-muted">Also known as {m.aliases.join(', ')}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <AvailabilityBadge value={m.serviceAvailability} />
          <Badge tone={m.recommendationStatus === 'eligible' ? 'success' : 'neutral'}>
            {recommendationLabel(m.recommendationStatus)}
          </Badge>
          {m.evidence.freshness === 'stale' ? <Badge tone="warning">Evidence stale</Badge> : null}
          {m.evidence.freshness === 'unknown' ? (
            <Badge tone="neutral">Evidence freshness unknown</Badge>
          ) : null}
        </div>
        {m.overlapNote ? (
          <Alert tone="info" title="Overlapping geography" className="mt-4">
            {m.overlapNote}
          </Alert>
        ) : null}
      </div>

      <div className="sx-container grid gap-8 pb-10 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0 space-y-10">
          {intro ? (
            <section aria-labelledby="intro-heading">
              <h2 id="intro-heading" className="text-xl font-semibold">
                {intro.title}
              </h2>
              <Prose html={intro.bodyHtml} className="mt-2" />
              {intro.publishedAt ? (
                <p className="mt-2 text-xs text-fg-subtle">
                  Editorial introduction published {formatDateLabel(intro.publishedAt)}; figures
                  below carry their own sources and dates.
                </p>
              ) : null}
            </section>
          ) : null}

          <section aria-labelledby="profile-heading">
            <h2 id="profile-heading" className="text-xl font-semibold">
              Profile
            </h2>
            {m.profileMarkdown ? (
              <Prose html={renderMarkdown(m.profileMarkdown)} className="mt-2" />
            ) : (
              <p className="mt-2 text-sm text-fg-muted">
                An editorial profile for {m.name} is pending review. Nothing is generated in its
                place.
              </p>
            )}
            {m.selectionBasis ? (
              <p className="mt-2 text-xs text-fg-subtle">Selection basis: {m.selectionBasis}</p>
            ) : null}
          </section>

          <section aria-labelledby="coverage-heading">
            <h2 id="coverage-heading" className="text-xl font-semibold">
              Service coverage
            </h2>
            <p className="mt-1 text-sm text-fg-muted">
              Availability is an operational fact confirmed per service. It is separate from map
              coverage: a marker on the map does not establish a staffed operation.
            </p>
            {m.serviceCoverage.length > 0 ? (
              <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-bg-elevated">
                {m.serviceCoverage.map((c) => (
                  <li
                    key={c.serviceSlug}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"
                  >
                    <Link
                      href={`/services/${c.serviceSlug}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {c.serviceName}
                    </Link>
                    <div className="flex items-center gap-2">
                      <AvailabilityBadge value={c.availability} />
                      {c.note ? <span className="text-xs text-fg-muted">{c.note}</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 rounded-md border border-dashed border-border p-4 text-sm text-fg-muted">
                No per-service availability has been confirmed for {m.name} yet; the market-level
                status above applies and each request is triaged individually.
              </p>
            )}
          </section>

          <section aria-labelledby="local-heading">
            <h2 id="local-heading" className="text-xl font-semibold">
              Local observations
            </h2>
            <p className="mt-1 text-sm text-fg-muted">
              City-level figures with their unit, statistic, period, sample size and source. Rank
              eligibility is decided by the data approver, not by the map.
            </p>
            <div className="mt-3">
              {m.localObservations.length > 0 ? (
                <ObservationTable
                  observations={m.localObservations}
                  caption={`Local observations for ${m.name}`}
                />
              ) : (
                <p className="rounded-md border border-dashed border-border p-4 text-sm text-fg-muted">
                  No city-level observations are published for {m.name}. No price is estimated in
                  their place.
                </p>
              )}
            </div>
          </section>

          <section aria-labelledby="statewide-heading">
            <h2 id="statewide-heading" className="text-xl font-semibold">
              Statewide context
            </h2>
            <Alert tone="warning" title="Statewide context, not a city value" className="mt-2">
              These figures describe {m.stateName} as a whole and mixed advertised stock. They are
              never used as a {m.name} price and never divided into a yield claim.
            </Alert>
            <div className="mt-3">
              {m.regionalContextObservations.length > 0 ? (
                <ObservationTable
                  observations={m.regionalContextObservations}
                  caption={`Statewide context observations for ${m.stateName}`}
                  statewide
                />
              ) : (
                <p className="rounded-md border border-dashed border-border p-4 text-sm text-fg-muted">
                  No statewide context observations are published for {m.stateName}.
                </p>
              )}
            </div>
          </section>

          <section aria-labelledby="suppliers-heading">
            <h2 id="suppliers-heading" className="text-xl font-semibold">
              Supplier research leads
            </h2>
            <p className="mt-1 text-sm text-fg-muted">
              Research leads, not verified delivery routes. Facility proximity is not a materials
              access score; delivered cost and lead time come from dated quotations.
            </p>
            <div className="mt-3">
              {m.supplierLeads.length > 0 ? (
                <DataTable
                  columns={leadColumns}
                  rows={m.supplierLeads}
                  rowKey={(l) => l.facilityId}
                  rowLabel={(l) => l.name}
                  caption={`Supplier research leads linked to ${m.name}`}
                />
              ) : (
                <p className="rounded-md border border-dashed border-border p-4 text-sm text-fg-muted">
                  No supplier leads are linked to {m.name} yet.
                </p>
              )}
            </div>
            {m.supplierQuotes.length > 0 ? (
              <div className="mt-4">
                <h3 className="text-base font-semibold">Dated supplier quotations</h3>
                <div className="mt-2">
                  <DataTable
                    columns={quoteColumns}
                    rows={m.supplierQuotes}
                    rowKey={(q) => q.id}
                    rowLabel={(q) => `${humanize(q.material)} ${q.specification}`}
                    caption={`Supplier quotations for ${m.name}`}
                  />
                </div>
              </div>
            ) : null}
            {m.supplyMappingMethod ? (
              <p className="mt-2 text-xs text-fg-subtle">Mapping method: {m.supplyMappingMethod}</p>
            ) : null}
          </section>

          <section aria-labelledby="missing-heading">
            <h2 id="missing-heading" className="text-xl font-semibold">
              Missing evidence
            </h2>
            <p className="mt-1 text-sm text-fg-muted">
              What must be collected before this market can be assessed further. Unknown never
              becomes a zero price or a perfect score.
            </p>
            {m.missingEvidence.length === 0 && openTasks.length === 0 ? (
              <p className="mt-3 text-sm text-fg-muted">No open evidence gaps are recorded.</p>
            ) : (
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                {m.missingEvidence.length > 0 ? (
                  <ul className="space-y-1.5 text-sm">
                    {m.missingEvidence.map((item) => (
                      <li key={item} className="flex gap-2">
                        <EvidenceBadge kind="unknown" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {openTasks.length > 0 ? (
                  <ul className="divide-y divide-border rounded-lg border border-border bg-bg-elevated text-sm">
                    {openTasks.map((t) => (
                      <li key={t.id} className="flex items-center justify-between gap-2 px-3 py-2">
                        <span>
                          {t.title}
                          <span className="block text-xs text-fg-muted">
                            {humanize(t.category)}
                          </span>
                        </span>
                        <Badge tone="neutral">{humanize(t.status)}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </section>

          {m.timelineTemplate ? (
            <section aria-labelledby="timeline-heading">
              <h2 id="timeline-heading" className="text-xl font-semibold">
                Timeline template
              </h2>
              <p className="mt-1 text-sm text-fg-muted">
                {m.timelineTemplate.name} ({humanize(m.timelineTemplate.status)}).{' '}
                {m.timelineTemplate.canComputeCompletionDate
                  ? 'A completion date can be computed under your stated assumptions in the explorer.'
                  : 'A completion date cannot be computed: this template is illustrative and incomplete.'}
              </p>
              {m.timelineTemplate.missingInputs.length > 0 ? (
                <p className="mt-1 text-xs text-fg-subtle">
                  Missing inputs: {m.timelineTemplate.missingInputs.join(', ')}
                </p>
              ) : null}
              {m.timelineTemplate.assumptionNotes ? (
                <p className="mt-1 text-xs text-fg-subtle">{m.timelineTemplate.assumptionNotes}</p>
              ) : null}
            </section>
          ) : null}

          <section aria-labelledby="neighbourhoods-heading">
            <h2 id="neighbourhoods-heading" className="text-xl font-semibold">
              Neighbourhoods
            </h2>
            {publishedNeighborhoods.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {publishedNeighborhoods.map((n) => (
                  <li key={n.id}>
                    <Badge tone="neutral">
                      {n.name}
                      {n.hasBoundary ? '' : ' (no boundary)'}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-fg-muted">
                No neighbourhoods are published for {m.name}. Boundaries are never fabricated from
                city points.
              </p>
            )}
          </section>

          {activeFlags.length > 0 ? (
            <section aria-labelledby="flags-heading">
              <h2 id="flags-heading" className="text-xl font-semibold">
                Flags
              </h2>
              <ul className="mt-2 space-y-2">
                {activeFlags.map((f) => (
                  <li key={f.id}>
                    <Alert tone="warning" title={humanize(f.flagType)}>
                      {f.note}
                      {f.validFrom || f.validUntil ? (
                        <span className="block text-xs">
                          Valid {f.validFrom ? `from ${formatDateLabel(f.validFrom)}` : ''}
                          {f.validUntil ? ` until ${formatDateLabel(f.validUntil)}` : ''}
                        </span>
                      ) : null}
                    </Alert>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <aside
          className="space-y-4 lg:sticky lg:top-24 lg:self-start"
          aria-label="Map position, review status and actions"
        >
          <div className="rounded-lg border border-border bg-bg-elevated p-5">
            <h2 className="text-base font-semibold">Map position</h2>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-fg-muted">Latitude</dt>
              <dd className="font-mono">{m.location.lat.toFixed(5)}</dd>
              <dt className="text-fg-muted">Longitude</dt>
              <dd className="font-mono">{m.location.lon.toFixed(5)}</dd>
              <dt className="text-fg-muted">Accuracy</dt>
              <dd>{m.coordinateAccuracy ?? 'Not stated'}</dd>
              <dt className="text-fg-muted">Source</dt>
              <dd>
                {m.coordinateSource?.url ? (
                  <a
                    href={m.coordinateSource.url}
                    rel="noopener noreferrer"
                    target="_blank"
                    className="text-primary underline"
                  >
                    {m.coordinateSource.title}
                  </a>
                ) : (
                  (m.coordinateSource?.title ?? 'Not stated')
                )}
              </dd>
            </dl>
            <p className="mt-2 text-xs text-fg-subtle">
              A reference coordinate, not a surveyed property location. WGS84.
            </p>
            <Link
              href={`/explore?market=${m.slug}`}
              className={`${buttonVariants({ variant: 'secondary', size: 'sm' })} mt-3`}
            >
              Show on the map
            </Link>
          </div>

          <div className="rounded-lg border border-border bg-bg-elevated p-5">
            <h2 className="text-base font-semibold">Evidence summary</h2>
            <dl className="mt-2 grid grid-cols-[1fr_auto] gap-y-1 text-sm">
              <dt className="text-fg-muted">Local observations</dt>
              <dd>{m.evidence.localObservations}</dd>
              <dt className="text-fg-muted">Statewide context</dt>
              <dd>{m.evidence.regionalContextObservations}</dd>
              <dt className="text-fg-muted">Supplier leads</dt>
              <dd>{m.evidence.supplierLeads}</dd>
              <dt className="text-fg-muted">Supplier quotes</dt>
              <dd>{m.evidence.supplierQuotes}</dd>
              <dt className="text-fg-muted">Open research tasks</dt>
              <dd>{m.evidence.openResearchTasks}</dd>
            </dl>
            {m.evidence.badges.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-1">
                {m.evidence.badges.map((b) => (
                  <EvidenceBadge key={b} kind={b} />
                ))}
              </div>
            ) : null}
            <p className="mt-3 text-xs text-fg-subtle">
              Last reviewed:{' '}
              {m.lastReviewedAt ? formatDateLabel(m.lastReviewedAt) : 'not yet reviewed'}
              <br />
              Last researched:{' '}
              {m.evidence.lastResearchedAt
                ? formatDateLabel(m.evidence.lastResearchedAt)
                : 'not recorded'}
              <br />
              Published: {m.publishedAt ? formatDateLabel(m.publishedAt) : '—'} · Version{' '}
              {m.version}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Link
              href={compareHref}
              className={buttonVariants({ variant: 'secondary', size: 'lg' })}
            >
              Compare in the explorer
            </Link>
            <Link href={bookHref} className={buttonVariants({ size: 'lg' })}>
              Book a consultation about {m.name}
            </Link>
          </div>
        </aside>
      </div>
    </>
  );
}
