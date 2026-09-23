import type { Metadata } from 'next';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { CtaBand } from '@/components/public/cta-band';
import { ABOUT_DEFAULT } from '@/components/public/defaults';
import { EvidenceStandards } from '@/components/public/evidence-standards';
import { Prose, Section } from '@/components/public/section';
import {
  contentByKind,
  contentBySlug,
  evidenceStandardsFromContent,
  publicMetadata,
  siteUrl,
} from '../_lib/site-data';

export const metadata: Metadata = publicMetadata({
  title: 'About',
  description:
    'SimplexD is a Nigerian property services and oversight platform: eight services, one engagement pipeline, and evidence standards that label every figure with its source and date.',
  path: '/about',
});

export default async function AboutPage() {
  const [cms, evidencePages] = await Promise.all([
    contentBySlug('about', 'page'),
    contentByKind('evidence_standard'),
  ]);
  const title = cms?.title ?? ABOUT_DEFAULT.title;
  return (
    <>
      <Breadcrumbs items={[{ name: 'About', href: '/about' }]} baseUrl={siteUrl()} />
      <div className="sx-container py-6">
        <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{title}</h1>
        {cms ? (
          <Prose html={cms.bodyHtml} className="mt-4" />
        ) : (
          <div className="mt-4 max-w-prose space-y-6">
            <p className="text-lg text-fg-muted">{ABOUT_DEFAULT.intro}</p>
            {ABOUT_DEFAULT.sections.map((s) => (
              <section
                key={s.heading}
                aria-labelledby={`about-${s.heading.replace(/\s+/g, '-').toLowerCase()}`}
              >
                <h2
                  id={`about-${s.heading.replace(/\s+/g, '-').toLowerCase()}`}
                  className="text-xl font-semibold"
                >
                  {s.heading}
                </h2>
                <p className="mt-2 text-fg-muted">{s.body}</p>
              </section>
            ))}
          </div>
        )}
      </div>
      <Section
        id="evidence-standards"
        eyebrow="Evidence standards"
        title="How every figure is labelled"
        tone="sunken"
      >
        <EvidenceStandards items={evidenceStandardsFromContent(evidencePages)} />
      </Section>
      <CtaBand />
    </>
  );
}
