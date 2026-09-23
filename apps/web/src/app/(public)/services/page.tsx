import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, buttonVariants, EmptyState, PageHeader } from '@simplexd/ui';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { CtaBand } from '@/components/public/cta-band';
import {
  EXPANSION_NOTE,
  GOAL_LABELS,
  GOAL_PATHS,
  type GoalKey,
} from '@/components/public/defaults';
import { Section } from '@/components/public/section';
import { ServiceCard, ServiceCardGrid } from '@/components/public/service-card';
import { loadCatalog, publicMetadata, siteUrl, type SearchParams } from '../_lib/site-data';

export const metadata: Metadata = publicMetadata({
  title: 'Services',
  description:
    'Eight core property services in Nigeria with concrete deliverables, completion evidence and editable price anchors, plus the planned expansion services available for inquiry only.',
  path: '/services',
});

export default async function ServicesPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const goalParam = typeof params.goal === 'string' ? params.goal : undefined;
  const goal = GOAL_PATHS.find((g) => g.key === goalParam) ?? null;
  const catalog = await loadCatalog();

  return (
    <>
      <Breadcrumbs items={[{ name: 'Services', href: '/services' }]} baseUrl={siteUrl()} />
      <div className="sx-container pt-4">
        <PageHeader
          eyebrow="Services"
          title="Eight core services, one evidence standard"
          description="Every service moves through the same pipeline: inquiry, triage, scoped quotation, acceptance, work with captured evidence and reviewed delivery. Prices are indicative anchors with a stated basis; the quotation is the price."
          actions={
            <>
              <Link href="/pricing" className={buttonVariants({ variant: 'secondary' })}>
                Pricing table
              </Link>
              <Link href="/book" className={buttonVariants()}>
                Request a service
              </Link>
            </>
          }
        />
        {goal ? (
          <p className="mt-4 rounded-md border border-primary/30 bg-primary-soft px-4 py-3 text-sm">
            Showing services that fit <strong>{GOAL_LABELS[goal.key as GoalKey]}</strong>.
            Highlighted cards produce the evidence that goal needs.{' '}
            <Link href="/services" className="text-primary underline">
              Show all equally
            </Link>
          </p>
        ) : null}
      </div>

      <Section id="core" title="Core services" headingLevel={2} className="pt-8">
        {catalog && catalog.core.length > 0 ? (
          <ServiceCardGrid>
            {[...catalog.core]
              .sort((a, b) => {
                if (!goal) return 0;
                const ai = goal.serviceSlugs.includes(a.slug) ? 0 : 1;
                const bi = goal.serviceSlugs.includes(b.slug) ? 0 : 1;
                return ai - bi || a.sortOrder - b.sortOrder;
              })
              .map((s) => (
                <ServiceCard
                  key={s.slug}
                  service={s}
                  highlighted={Boolean(goal?.serviceSlugs.includes(s.slug))}
                />
              ))}
          </ServiceCardGrid>
        ) : (
          <EmptyState
            tone="warning"
            title="The service catalogue is not available right now"
            description="The database did not respond. You can still send a consultation request."
            action={
              <Link href="/book" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                Request a consultation
              </Link>
            }
          />
        )}
      </Section>

      <Section
        id="planned"
        eyebrow="Planned services"
        title="Expansion portfolio: inquiry only, not yet bookable"
        description={EXPANSION_NOTE}
        tone="sunken"
      >
        {catalog && catalog.planned.length > 0 ? (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {catalog.planned.map((s) => (
              <li
                key={s.slug}
                className="flex flex-col rounded-lg border border-border bg-bg-elevated p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold">
                    <Link href={`/services/${s.slug}`} className="hover:underline">
                      {s.name}
                    </Link>
                  </h3>
                  <Badge tone={s.availability === 'request' ? 'success' : 'neutral'}>
                    {s.availability === 'request'
                      ? 'Open for requests'
                      : 'Inquiry only, not yet bookable'}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-fg-muted">{s.shortDescription}</p>
                {s.commercialModel ? (
                  <p className="mt-2 text-xs text-fg-subtle">
                    Commercial model: {s.commercialModel}
                  </p>
                ) : null}
                <Link
                  href={`/book?service=${s.slug}&interest=1`}
                  className="mt-auto pt-3 text-sm font-medium text-primary underline"
                >
                  Register interest
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">No planned services are listed at the moment.</p>
        )}
      </Section>

      <CtaBand />
    </>
  );
}
