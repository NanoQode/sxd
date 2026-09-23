import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, buttonVariants, EmptyState, formatDateLabel, PageHeader } from '@simplexd/ui';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { CtaBand } from '@/components/public/cta-band';
import { SampleReports } from '@/components/public/how-it-works';
import { Prose, Section } from '@/components/public/section';
import { contentByKind, fieldString, publicMetadata, siteUrl } from '../_lib/site-data';

export const metadata: Metadata = publicMetadata({
  title: 'Projects',
  description:
    'Approved case studies from SimplexD engagements, published only with the owner’s publication rights. Until then, sample report outlines describe what each engagement delivers.',
  path: '/projects',
});

export default async function ProjectsPage() {
  const caseStudies = await contentByKind('case_study');
  return (
    <>
      <Breadcrumbs items={[{ name: 'Projects', href: '/projects' }]} baseUrl={siteUrl()} />
      <div className="sx-container py-6">
        <PageHeader
          eyebrow="Projects"
          title="Approved case studies"
          description="An engagement appears here only after the owner grants publication rights and the content is redacted and reviewed. There are no project claims without evidence."
        />
      </div>
      <div className="sx-container pb-6">
        {caseStudies.length === 0 ? (
          <EmptyState
            title="Approved case studies will appear here once owners grant publication rights"
            description="Every engagement produces reviewed, versioned reports; publishing them publicly is the owner's decision."
            action={
              <Link
                href="/how-it-works"
                className={buttonVariants({ variant: 'secondary', size: 'sm' })}
              >
                See how an engagement runs
              </Link>
            }
          />
        ) : (
          <div className="space-y-8">
            {caseStudies.map((c) => {
              const location = fieldString(c, 'location');
              const serviceSlug = fieldString(c, 'serviceSlug');
              const completedAt = fieldString(c, 'completedAt');
              return (
                <article
                  key={c.slug}
                  id={c.slug}
                  className="rounded-lg border border-border bg-bg-elevated p-5 sm:p-6"
                >
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone="success">Publication rights granted</Badge>
                    {location ? <Badge tone="neutral">{location}</Badge> : null}
                    {completedAt ? (
                      <Badge tone="neutral">Completed {formatDateLabel(completedAt)}</Badge>
                    ) : null}
                  </div>
                  <h2 className="mt-2 text-xl font-semibold">{c.title}</h2>
                  {serviceSlug ? (
                    <p className="mt-1 text-sm text-fg-muted">
                      Service:{' '}
                      <Link href={`/services/${serviceSlug}`} className="text-primary underline">
                        {serviceSlug.replace(/-/g, ' ')}
                      </Link>
                    </p>
                  ) : null}
                  <Prose html={c.bodyHtml} className="mt-3" />
                  {c.publishedAt ? (
                    <p className="mt-3 text-xs text-fg-subtle">
                      Published {formatDateLabel(c.publishedAt)}
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
      <Section
        id="sample-reports"
        eyebrow="Sample redacted reports"
        title="What each engagement delivers"
        tone="sunken"
      >
        <SampleReports />
      </Section>
      <CtaBand />
    </>
  );
}
