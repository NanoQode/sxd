import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonVariants, cn, EmptyState } from '@simplexd/ui';
import { getIdentity } from '@/lib/auth/session';
import { LocationExplorer } from '@/components/explorer';
import { explorerAccessFor } from '@/components/explorer/access';
import { ConsultationForm } from '@/components/public/consultation-form';
import { readPrefill } from '@/components/public/consultation-schema';
import { DEFAULT_FAQS, HERO, SITE } from '@/components/public/defaults';
import { EvidenceStandards } from '@/components/public/evidence-standards';
import { FaqList } from '@/components/public/faq-list';
import { GoalPaths } from '@/components/public/goal-paths';
import { SampleReports, WorkflowSteps } from '@/components/public/how-it-works';
import { Illustration } from '@/components/public/illustration';
import { faqJsonLd, JsonLd, organizationJsonLd, websiteJsonLd } from '@/components/public/json-ld';
import { Section } from '@/components/public/section';
import { ServiceCard, ServiceCardGrid } from '@/components/public/service-card';
import {
  contentByKind,
  evidenceStandardsFromContent,
  excerpt,
  faqsFromContent,
  loadCatalog,
  loadGoalPaths,
  publicMetadata,
  siteUrl,
  type SearchParams,
} from './_lib/site-data';

export const metadata: Metadata = publicMetadata({
  title: `${SITE.name} — ${SITE.tagline}`,
  description: SITE.description,
  path: '/',
  absoluteTitle: true,
});

export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const prefill = readPrefill(params);
  const [catalog, caseStudies, testimonials, faqPages, evidencePages, goals, identity] =
    await Promise.all([
      loadCatalog(),
      contentByKind('case_study'),
      contentByKind('testimonial'),
      contentByKind('faq'),
      contentByKind('evidence_standard'),
      loadGoalPaths(),
      getIdentity(),
    ]);
  const faqs = faqPages.length > 0 ? faqsFromContent(faqPages) : DEFAULT_FAQS;
  const evidence = evidenceStandardsFromContent(evidencePages);
  const serviceNames = Object.fromEntries((catalog?.core ?? []).map((s) => [s.slug, s.name]));
  const formServices = [...(catalog?.core ?? []), ...(catalog?.planned ?? [])].map((s) => ({
    slug: s.slug,
    name: s.name,
    category: s.category,
  }));
  const base = siteUrl();

  return (
    <>
      <JsonLd
        data={[
          organizationJsonLd({ name: SITE.name, url: base, description: SITE.description }),
          websiteJsonLd({ name: SITE.name, url: base }),
          faqJsonLd(faqs.map((f) => ({ question: f.question, answerText: f.answerText }))),
        ]}
      />

      {/* 1. Value proposition and two actions */}
      <section
        aria-labelledby="hero-heading"
        className="sx-container grid gap-8 py-10 sm:py-16 lg:grid-cols-[3fr_2fr] lg:items-center"
      >
        <div className="max-w-2xl">
          <p className="text-xs font-medium tracking-wide text-primary uppercase">{HERO.eyebrow}</p>
          <h1
            id="hero-heading"
            className="font-display mt-2 text-3xl font-semibold leading-tight sm:text-4xl lg:text-5xl"
          >
            {HERO.title}
          </h1>
          <p className="mt-4 text-base text-fg-muted sm:text-lg">{HERO.body}</p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link
              href={HERO.primary.href}
              className={cn(buttonVariants({ size: 'lg' }), 'w-full sm:w-auto')}
            >
              {HERO.primary.label}
            </Link>
            <Link
              href={HERO.secondary.href}
              className={cn(
                buttonVariants({ variant: 'secondary', size: 'lg' }),
                'w-full sm:w-auto',
              )}
            >
              {HERO.secondary.label}
            </Link>
          </div>
          <ul className="mt-6 space-y-1.5 text-sm text-fg-muted">
            {HERO.points.map((p) => (
              <li key={p} className="flex gap-2">
                <span
                  aria-hidden="true"
                  className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-gold"
                />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="hidden lg:block">
          <Illustration name="site-plan" priority className="max-w-md" />
        </div>
      </section>

      {/* 2. Location explorer near the top */}
      <section aria-label="Location explorer" className="sx-container pb-10 sm:pb-14">
        <LocationExplorer variant="homepage" access={explorerAccessFor(identity)} />
        <p className="mt-3 text-sm text-fg-muted">
          Explore anonymously. Each market shows its evidence badges, service availability and what
          is still missing; saving a scenario or requesting verification asks for an account.{' '}
          <Link href="/locations" className="text-primary underline">
            Browse all locations as a list
          </Link>
          .
        </p>
      </section>

      {/* 3. Eight service cards */}
      <Section
        id="services"
        eyebrow="Services"
        title="Eight services with concrete deliverables"
        description="Each card shows what you receive and the editable starting price with its basis. Final pricing is always a scoped quotation."
        actions={
          <>
            <Link href="/services" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
              All services
            </Link>
            <Link href="/pricing" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              Pricing
            </Link>
          </>
        }
        tone="sunken"
      >
        {catalog && catalog.core.length > 0 ? (
          <ServiceCardGrid>
            {catalog.core.map((s) => (
              <ServiceCard key={s.slug} service={s} />
            ))}
          </ServiceCardGrid>
        ) : (
          <EmptyState
            tone="warning"
            title="The service catalogue is not available right now"
            description="The database did not respond. Consultation requests still work from the form below."
          />
        )}
      </Section>

      {/* 4. Goal paths */}
      <Section
        id="goals"
        eyebrow="Start from your goal"
        title="Buy safely, build with oversight, manage, or invest and compare"
        description="Each path combines the services that produce the evidence you need and carries your choices into the consultation request."
      >
        <GoalPaths serviceNames={serviceNames} goals={goals} />
      </Section>

      {/* 5. How it works, case studies, sample reports, evidence standards */}
      <Section
        id="how-it-works"
        eyebrow="How the service works"
        title="Inquiry to reviewed delivery, with evidence at each step"
        description="One engagement pipeline is shared by every service. Rejected, paused or cancelled paths always record a reason."
        actions={
          <Link
            href="/how-it-works"
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
          >
            Read the full process
          </Link>
        }
        tone="sunken"
      >
        <WorkflowSteps compact />
      </Section>

      <Section
        id="case-studies"
        eyebrow="Approved case studies"
        title="Projects with publication rights"
        description="Only engagements whose owners granted publication rights appear here."
      >
        {caseStudies.length > 0 ? (
          <ul className="grid gap-4 md:grid-cols-3">
            {caseStudies.slice(0, 3).map((c) => (
              <li key={c.slug} className="rounded-lg border border-border bg-bg-elevated p-4">
                <h3 className="text-base font-semibold">
                  <Link href={`/projects#${c.slug}`} className="hover:underline">
                    {c.title}
                  </Link>
                </h3>
                <p className="mt-1 text-sm text-fg-muted">{excerpt(c, 200)}</p>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="Approved case studies will appear here once owners grant publication rights"
            description="Until then, the sample report outlines below describe exactly what each engagement delivers."
            action={
              <Link
                href="/projects"
                className={buttonVariants({ variant: 'secondary', size: 'sm' })}
              >
                Projects page
              </Link>
            }
          />
        )}
      </Section>

      <Section
        id="sample-reports"
        eyebrow="Sample redacted reports"
        title="What a report contains"
        tone="sunken"
      >
        <SampleReports />
      </Section>

      <Section
        id="evidence-standards"
        eyebrow="Evidence standards"
        title="Eight badges instead of one generic “verified” label"
        description="Every figure on a location page carries one of these badges together with its unit, date, sample size and source."
      >
        <EvidenceStandards items={evidence} />
      </Section>

      {/* 6. Customer stories only when approved; FAQs; consultation form */}
      {testimonials.length > 0 ? (
        <Section
          id="customer-stories"
          eyebrow="Customer stories"
          title="In their words"
          description="Published only with the customer's written consent."
          tone="sunken"
        >
          <ul className="grid gap-4 md:grid-cols-2">
            {testimonials.slice(0, 4).map((t) => (
              <li key={t.slug} className="rounded-lg border border-border bg-bg-elevated p-5">
                <blockquote
                  className="sx-prose text-sm"
                  dangerouslySetInnerHTML={{ __html: t.bodyHtml }}
                />
                <p className="mt-3 text-sm font-medium">
                  {typeof t.fields.author === 'string' ? t.fields.author : t.title}
                  {typeof t.fields.location === 'string' ? (
                    <span className="font-normal text-fg-muted"> · {t.fields.location}</span>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section
        id="faq"
        eyebrow="Questions"
        title="Frequently asked questions"
        tone={testimonials.length > 0 ? 'default' : 'sunken'}
      >
        <div className="max-w-3xl">
          <FaqList items={faqs} />
        </div>
      </Section>

      <Section
        id="consultation"
        eyebrow="Consultation"
        title="Request a consultation"
        description="Short form; your explored locations, budget and scenario are carried in automatically when you arrive from the explorer."
      >
        <div className="grid gap-8 lg:grid-cols-[3fr_2fr]">
          <div className="rounded-lg border border-border bg-bg-elevated p-5 sm:p-6">
            <ConsultationForm services={formServices} prefill={prefill} variant="homepage" />
          </div>
          <aside
            className="space-y-4 text-sm text-fg-muted"
            aria-label="What happens after you send the form"
          >
            <h3 className="text-base font-semibold text-fg">What happens next</h3>
            <ol className="list-decimal space-y-2 pl-5">
              <li>The team confirms the service fits and checks availability for your location.</li>
              <li>You receive a scoped quotation with price basis, exclusions and validity.</li>
              <li>
                Work starts after acceptance and, where required, payment through hosted checkout.
              </li>
            </ol>
            <p>
              Prefer to explore first?{' '}
              <Link href="/explore" className="text-primary underline">
                Compare locations
              </Link>{' '}
              and send the request from there so it carries your selections.
            </p>
            <Illustration name="evidence-report" className="hidden max-w-xs lg:block" />
          </aside>
        </div>
      </Section>
    </>
  );
}
