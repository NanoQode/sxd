import Link from 'next/link';
import type { PublishedContent } from '@simplexd/contracts';
import { Alert, buttonVariants } from '@simplexd/ui';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { CtaBand } from '@/components/public/cta-band';
import { Illustration, type IllustrationName } from '@/components/public/illustration';
import { Prose, Section } from '@/components/public/section';
import { siteUrl } from './site-data';

export interface AudienceCopy {
  title: string;
  intro: string;
  capabilities: ReadonlyArray<{ heading: string; body: string }>;
  availabilityNote: string;
}

/**
 * Shared layout for the diaspora and local-Nigeria landing pages: product
 * capabilities described as capabilities of the portal, never as scale claims.
 */
export function AudiencePage({
  path,
  copy,
  cms,
  illustration,
  goalHref,
}: {
  path: string;
  copy: AudienceCopy;
  cms: PublishedContent | null;
  illustration: IllustrationName;
  goalHref: string;
}) {
  const title = cms?.title ?? copy.title;
  return (
    <>
      <Breadcrumbs items={[{ name: title, href: path }]} baseUrl={siteUrl()} />
      <section
        aria-labelledby="audience-heading"
        className="sx-container grid gap-8 py-8 lg:grid-cols-[3fr_2fr] lg:items-center"
      >
        <div className="max-w-2xl">
          <h1
            id="audience-heading"
            className="font-display text-3xl font-semibold leading-tight sm:text-4xl"
          >
            {title}
          </h1>
          {cms ? (
            <Prose html={cms.bodyHtml} className="mt-4" />
          ) : (
            <p className="mt-4 text-lg text-fg-muted">{copy.intro}</p>
          )}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link href="/book" className={buttonVariants({ size: 'lg' })}>
              Book a consultation
            </Link>
            <Link href={goalHref} className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
              Explore where to build
            </Link>
          </div>
        </div>
        <div className="hidden lg:block">
          <Illustration name={illustration} className="max-w-md" />
        </div>
      </section>
      <Section
        id="capabilities"
        eyebrow="Portal capabilities"
        title="What the platform does for you"
        tone="sunken"
      >
        <ul className="grid gap-4 sm:grid-cols-2">
          {copy.capabilities.map((c) => (
            <li key={c.heading} className="rounded-lg border border-border bg-bg-elevated p-5">
              <h3 className="text-base font-semibold">{c.heading}</h3>
              <p className="mt-1 text-sm text-fg-muted">{c.body}</p>
            </li>
          ))}
        </ul>
        <Alert tone="info" title="Availability" className="mt-6">
          {copy.availabilityNote}
        </Alert>
      </Section>
      <CtaBand />
    </>
  );
}
