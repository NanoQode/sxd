import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Badge, buttonVariants, formatDateLabel, StatusBadge } from '@simplexd/ui';
import { PageAction } from '@/components/public/action-bar';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { CtaBand } from '@/components/public/cta-band';
import { SITE } from '@/components/public/defaults';
import { WorkflowSteps } from '@/components/public/how-it-works';
import { JsonLd, serviceJsonLd, serviceOfferJsonLd } from '@/components/public/json-ld';
import { basisLabel, priceStatusLabel } from '@/components/public/price-anchor';
import { Prose, Section } from '@/components/public/section';
import { ServiceIcon } from '@/components/public/service-icon';
import { getServiceCoverageSummary, type ServiceCatalogItem } from '@/server/services/catalog';
import { absoluteUrl, loadCatalog, publicMetadata, siteUrl } from '../../_lib/site-data';

type Params = Promise<{ slug: string }>;

async function findService(slug: string): Promise<ServiceCatalogItem | null> {
  const catalog = await loadCatalog();
  if (!catalog) return null;
  return [...catalog.core, ...catalog.planned].find((s) => s.slug === slug) ?? null;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const service = await findService(slug);
  if (!service) return { title: 'Service not found', robots: { index: false, follow: false } };
  const planned = service.category === 'expansion';
  return publicMetadata({
    title: service.cms?.seo?.title ?? `${service.name}${planned ? ' (planned)' : ''}`,
    description: service.cms?.seo?.description ?? service.shortDescription,
    path: `/services/${service.slug}`,
    noindex: planned || Boolean(service.cms?.seo?.noindex),
  });
}

export default async function ServiceDetailPage({ params }: { params: Params }) {
  const { slug } = await params;
  const service = await findService(slug);
  if (!service) notFound();
  const planned = service.category === 'expansion';
  const coverage = await getServiceCoverageSummary(service.id).catch(() => null);
  const requestHref = planned
    ? `/book?service=${service.slug}&interest=1`
    : `/book?service=${service.slug}`;
  const requestLabel = planned ? 'Register interest' : 'Request this service';
  const base = siteUrl();
  const offer = service.primaryPackage
    ? serviceOfferJsonLd({
        priceBasis: service.primaryPackage.priceBasis,
        amountKobo: service.primaryPackage.amountKobo,
        publicationState: service.primaryPackage.publicationState,
      })
    : null;

  return (
    <>
      <PageAction label={requestLabel} href={requestHref} />
      {!planned ? (
        <JsonLd
          data={serviceJsonLd({
            name: service.name,
            description: service.shortDescription,
            url: absoluteUrl(`/services/${service.slug}`),
            providerName: SITE.name,
            providerUrl: base,
            offer,
          })}
        />
      ) : null}
      <Breadcrumbs
        items={[
          { name: 'Services', href: '/services' },
          { name: service.name, href: `/services/${service.slug}` },
        ]}
        baseUrl={base}
      />
      <div className="sx-container grid gap-8 py-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          <div className="flex items-start gap-4">
            <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
              <ServiceIcon iconKey={service.iconKey} className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">
                {planned ? 'Planned service' : 'Core service'}
              </p>
              <h1 className="font-display text-2xl font-semibold leading-tight sm:text-3xl">{service.name}</h1>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {planned ? (
                  <Badge tone={service.availability === 'request' ? 'success' : 'neutral'}>
                    {service.availability === 'request' ? 'Open for requests' : 'Inquiry only, not yet bookable'}
                  </Badge>
                ) : (
                  <Badge tone="success">Available by consultation request</Badge>
                )}
                <StatusBadge status={service.publicationState} />
              </div>
            </div>
          </div>
          <p className="mt-4 max-w-prose text-base text-fg-muted">{service.shortDescription}</p>
          {service.descriptionHtml ? <Prose html={service.descriptionHtml} className="mt-4" /> : null}

          {planned ? (
            <Alert tone="info" title="Why this service is not bookable yet" className="mt-6">
              This workflow template is activated in a later release wave and stays unavailable for
              booking until it is staffed
              {service.featureFlagKey ? (
                <>
                  {' '}
                  (feature flag <code className="font-mono">{service.featureFlagKey}</code> is{' '}
                  {service.featureFlagEnabled ? 'on' : 'off'})
                </>
              ) : null}
              . Registering interest lets the team tell you when it opens.
              {service.commercialModel ? ` Commercial model: ${service.commercialModel}.` : ''}
            </Alert>
          ) : null}

          <section aria-labelledby="deliverables-heading" className="mt-8">
            <h2 id="deliverables-heading" className="text-xl font-semibold">
              Deliverables
            </h2>
            {service.deliverables.length > 0 ? (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {service.deliverables.map((d) => (
                  <li key={d} className="flex gap-2 rounded-md border border-border bg-bg-elevated px-3 py-2 text-sm">
                    <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                    <span>{d}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-fg-muted">
                Deliverables are defined per activated workflow template once this service is staffed.
              </p>
            )}
          </section>

          <section aria-labelledby="evidence-heading" className="mt-8">
            <h2 id="evidence-heading" className="text-xl font-semibold">
              Completion evidence
            </h2>
            <p className="mt-2 max-w-prose text-sm text-fg-muted">
              {service.completionEvidence ?? 'Documented outcome per activated workflow template.'}
            </p>
          </section>

          <section aria-labelledby="workflow-heading" className="mt-8">
            <h2 id="workflow-heading" className="text-xl font-semibold">
              Workflow steps
            </h2>
            <p className="mt-2 mb-4 max-w-prose text-sm text-fg-muted">
              Shared engagement pipeline. Rejected, paused and cancelled paths always record a reason
              and the billing consequence.
            </p>
            <WorkflowSteps />
          </section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start" aria-label="Pricing and availability">
          <div className="rounded-lg border border-border bg-bg-elevated p-5">
            <h2 className="text-base font-semibold">Price anchor</h2>
            {planned ? (
              <p className="mt-2 text-sm text-fg-muted">
                No price anchor is published for a planned service. Pricing follows the commercial
                model once the service is staffed and reviewed.
              </p>
            ) : service.packages.length === 0 ? (
              <p className="mt-2 text-sm text-fg-muted">Indicative price under business review.</p>
            ) : (
              <ul className="mt-2 space-y-4">
                {service.packages.map((pkg) => (
                  <li key={pkg.id} className="text-sm">
                    <p className="font-medium">{pkg.name}</p>
                    <p className="text-lg font-semibold text-fg">{pkg.priceLabel ?? 'Not published'}</p>
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-fg-muted">
                      <dt>Basis</dt>
                      <dd className="text-fg">{basisLabel(pkg.priceBasis)}</dd>
                      <dt>Minimum scope</dt>
                      <dd className="text-fg">{pkg.minimumScope ?? 'Stated in the quotation'}</dd>
                      <dt>Exclusions</dt>
                      <dd className="text-fg">{pkg.exclusions ?? 'Stated in the quotation'}</dd>
                      <dt>Effective</dt>
                      <dd className="text-fg">
                        {pkg.effectiveFrom ? `from ${formatDateLabel(pkg.effectiveFrom)}` : 'Not set'}
                        {pkg.effectiveTo ? ` to ${formatDateLabel(pkg.effectiveTo)}` : ''}
                      </dd>
                      <dt>Status</dt>
                      <dd>
                        <StatusBadge status={pkg.publicationState} label={priceStatusLabel(pkg.publicationState)} />
                      </dd>
                    </dl>
                    {pkg.priceBasis === 'percentage' ? (
                      <p className="mt-2 text-xs text-fg-subtle">
                        Never calculated without an agreed percentage basis and a signed scope.
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-fg-subtle">
              Anchors are indicative and editable by the business; your price is the scoped quotation.
            </p>
            <Link href={requestHref} className={`${buttonVariants({ size: 'lg' })} mt-4 w-full`}>
              {requestLabel}
            </Link>
          </div>

          <div className="rounded-lg border border-border bg-bg-elevated p-5">
            <h2 className="text-base font-semibold">Related locations</h2>
            <p className="mt-2 text-sm text-fg-muted">
              Service availability is confirmed per location and shown separately from map coverage.
            </p>
            {coverage ? (
              <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1 text-sm">
                <dt className="text-fg-muted">Published locations</dt>
                <dd className="text-right">{coverage.publishedMarkets}</dd>
                <dt className="text-fg-muted">Available</dt>
                <dd className="text-right">{coverage.available}</dd>
                <dt className="text-fg-muted">Limited</dt>
                <dd className="text-right">{coverage.limited}</dd>
                <dt className="text-fg-muted">On request</dt>
                <dd className="text-right">{coverage.onRequest}</dd>
                <dt className="text-fg-muted">Pending confirmation</dt>
                <dd className="text-right">{coverage.pending}</dd>
              </dl>
            ) : (
              <p className="mt-3 text-sm text-fg-muted">Coverage counts are not available right now.</p>
            )}
            {coverage && coverage.available + coverage.limited + coverage.onRequest === 0 ? (
              <p className="mt-2 text-xs text-fg-subtle">
                No location has confirmed availability for this service yet; requests are triaged individually.
              </p>
            ) : null}
            <Link href="/locations" className="mt-3 inline-block text-sm text-primary underline">
              See all locations
            </Link>
          </div>
        </aside>
      </div>
      <Section id="more" title="Other services" headingLevel={2} className="pt-2">
        <p className="text-sm text-fg-muted">
          <Link href="/services" className="text-primary underline">
            Browse all eight core services
          </Link>{' '}
          or compare{' '}
          <Link href="/pricing" className="text-primary underline">
            price anchors side by side
          </Link>
          .
        </p>
      </Section>
      <CtaBand primary={{ label: requestLabel, href: requestHref }} />
    </>
  );
}
