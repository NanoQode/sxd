import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonVariants, PageHeader } from '@simplexd/ui';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { CtaBand } from '@/components/public/cta-band';
import { SampleReports, WorkflowSteps } from '@/components/public/how-it-works';
import { Illustration } from '@/components/public/illustration';
import { Section } from '@/components/public/section';
import { publicMetadata, siteUrl } from '../_lib/site-data';

export const metadata: Metadata = publicMetadata({
  title: 'How it works',
  description:
    'How a SimplexD engagement runs: inquiry, triage, scoped quotation, acceptance, invoice and payment where required, assigned work with captured evidence, reviewed delivery, completion and feedback.',
  path: '/how-it-works',
});

const PRINCIPLES = [
  {
    heading: 'Who does the work',
    body: 'Named SimplexD staff or vetted partners (inspectors, surveyors, legal professionals, architects, quantity surveyors, contractors). Partners see only the assignments and evidence given to them; customers never see internal staff notes.',
  },
  {
    heading: 'How evidence is handled',
    body: 'Uploads store capture time, uploader, checksum and optional GPS separately from server receipt time. Originals stay restricted; compressed derivatives are generated; only approved or redacted versions are published. EXIF and GPS are user-provided evidence, not proof of authenticity.',
  },
  {
    heading: 'Approvals are separate decisions',
    body: 'An inspector’s progress estimate, your milestone approval and finance’s payment authorisation are three distinct records. A change order cannot alter the approved budget until the approvals required by policy are present.',
  },
  {
    heading: 'Payments',
    body: 'Invoices are issued in naira and paid through hosted checkout once the payment gateway is configured, or by a declared bank transfer that finance confirms. Duplicate or reordered payment events never allocate money twice; there are no wallets and no escrow badge.',
  },
  {
    heading: 'Pauses, rejections and cancellations',
    body: 'Every exit from the pipeline records a reason and its billing consequence: unpaid invoices are voided, paid work is invoiced pro rata or refunded per policy, and finance reviews the outcome.',
  },
  {
    heading: 'Reports and review',
    body: 'A reviewer other than the author approves each report before release. Released reports keep their version history; a newer version supersedes, never overwrites.',
  },
] as const;

export default function HowItWorksPage() {
  return (
    <>
      <Breadcrumbs items={[{ name: 'How it works', href: '/how-it-works' }]} baseUrl={siteUrl()} />
      <div className="sx-container grid gap-8 py-6 lg:grid-cols-[3fr_2fr] lg:items-center">
        <PageHeader
          eyebrow="How it works"
          title="One pipeline, evidence at every step"
          description="Every service, from a single virtual inspection to a year of construction monitoring, moves through the same deliberate states. Variations are explicit transitions with permissions, not improvisation."
          actions={
            <Link href="/book" className={buttonVariants()}>
              Start an inquiry
            </Link>
          }
        />
        <div className="hidden lg:block">
          <Illustration name="evidence-report" className="max-w-sm" />
        </div>
      </div>
      <Section id="steps" title="The engagement pipeline" headingLevel={2} className="pt-2">
        <WorkflowSteps />
      </Section>
      <Section id="principles" eyebrow="Operating rules" title="What stays true in every engagement" tone="sunken">
        <ul className="grid gap-4 md:grid-cols-2">
          {PRINCIPLES.map((p) => (
            <li key={p.heading} className="rounded-lg border border-border bg-bg-elevated p-5">
              <h3 className="text-base font-semibold">{p.heading}</h3>
              <p className="mt-1 text-sm text-fg-muted">{p.body}</p>
            </li>
          ))}
        </ul>
      </Section>
      <Section id="sample-reports" eyebrow="Sample redacted reports" title="What you receive">
        <SampleReports />
      </Section>
      <CtaBand />
    </>
  );
}
