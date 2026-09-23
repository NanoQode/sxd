import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert } from '@simplexd/ui';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { ConsultationForm } from '@/components/public/consultation-form';
import { readPrefill } from '@/components/public/consultation-schema';
import { BOOK_DEFAULT } from '@/components/public/defaults';
import { Illustration } from '@/components/public/illustration';
import { loadCatalog, publicMetadata, siteUrl, type SearchParams } from '../_lib/site-data';

export const metadata: Metadata = publicMetadata({
  title: 'Book a consultation',
  description:
    'Request a consultation with the SimplexD team. Share your property, goal, location and preferred times; calendar scheduling with Google Meet invitations follows once the calendar integration is configured.',
  path: '/book',
});

export default async function BookPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const catalog = await loadCatalog();
  const base = readPrefill(params);
  const selected = base.serviceSlug
    ? [...(catalog?.core ?? []), ...(catalog?.planned ?? [])].find(
        (s) => s.slug === base.serviceSlug,
      )
    : undefined;
  const prefill = {
    ...base,
    // A planned service is never bookable; the request becomes an interest registration.
    interest: base.interest || selected?.availability === 'inquiry_only',
  };
  const services = [...(catalog?.core ?? []), ...(catalog?.planned ?? [])].map((s) => ({
    slug: s.slug,
    name: s.name,
    category: s.category,
  }));

  return (
    <>
      <Breadcrumbs items={[{ name: 'Book a consultation', href: '/book' }]} baseUrl={siteUrl()} />
      <div className="sx-container grid gap-8 py-6 lg:grid-cols-[3fr_2fr]">
        <div>
          <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
            {BOOK_DEFAULT.title}
          </h1>
          <p className="mt-3 max-w-prose text-lg text-fg-muted">{BOOK_DEFAULT.intro}</p>
          {selected ? (
            <p className="mt-3 text-sm">
              Selected service: <strong>{selected.name}</strong>{' '}
              <Link href={`/services/${selected.slug}`} className="text-primary underline">
                (details)
              </Link>
            </p>
          ) : null}
          <Alert tone="info" title="Scheduling" className="mt-4">
            {BOOK_DEFAULT.schedulingNote}
          </Alert>
          <div className="mt-6 rounded-lg border border-border bg-bg-elevated p-5 sm:p-6">
            <ConsultationForm services={services} prefill={prefill} variant="book" />
          </div>
        </div>
        <aside
          className="space-y-6 lg:sticky lg:top-24 lg:self-start"
          aria-label="What to prepare and what happens next"
        >
          <div className="rounded-lg border border-border bg-bg-elevated p-5">
            <h2 className="text-base font-semibold">Useful to have ready</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-fg-muted">
              <li>The location (city or state) and, if known, the estate or street.</li>
              <li>Any survey plan, title document or drawings you already hold.</li>
              <li>Your budget range and target dates, even if approximate.</li>
              <li>Who else should be able to view or approve decisions.</li>
            </ul>
            <p className="mt-3 text-xs text-fg-subtle">
              Identity documents are requested only when a chosen transaction requires them.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-bg-elevated p-5">
            <h2 className="text-base font-semibold">What happens next</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-fg-muted">
              <li>You receive an email acknowledgement with a reference.</li>
              <li>
                The team confirms scope and proposes a consultation time in your time zone and
                Africa/Lagos.
              </li>
              <li>
                After the consultation you receive a scoped quotation with its price basis and
                validity.
              </li>
            </ol>
          </div>
          <Illustration name="coordination" className="hidden max-w-xs lg:block" />
        </aside>
      </div>
    </>
  );
}
