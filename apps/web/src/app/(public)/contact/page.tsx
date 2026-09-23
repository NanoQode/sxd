import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { ConsultationForm } from '@/components/public/consultation-form';
import { readPrefill } from '@/components/public/consultation-schema';
import { CONTACT_FALLBACK } from '@/components/public/defaults';
import { Prose } from '@/components/public/section';
import { contentBySlug, fieldString, loadCatalog, publicMetadata, siteUrl, type SearchParams } from '../_lib/site-data';

export const metadata: Metadata = publicMetadata({
  title: 'Contact',
  description: 'Contact the SimplexD team about property services in Nigeria, or send a request through the form.',
  path: '/contact',
});

export default async function ContactPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const [contact, catalog] = await Promise.all([contentBySlug('contact', 'contact'), loadCatalog()]);
  const email = fieldString(contact, 'email');
  const phone = fieldString(contact, 'phone');
  const whatsapp = fieldString(contact, 'whatsapp');
  const address = fieldString(contact, 'address');
  const hours = fieldString(contact, 'hours');
  const responseTime = fieldString(contact, 'responseTime');
  const hasDetails = Boolean(email || phone || whatsapp || address);
  const services = [...(catalog?.core ?? []), ...(catalog?.planned ?? [])].map((s) => ({
    slug: s.slug,
    name: s.name,
    category: s.category,
  }));

  return (
    <>
      <Breadcrumbs items={[{ name: 'Contact', href: '/contact' }]} baseUrl={siteUrl()} />
      <div className="sx-container grid gap-8 py-6 lg:grid-cols-[2fr_3fr]">
        <div>
          <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{contact?.title ?? 'Contact SimplexD'}</h1>
          {contact?.bodyHtml ? <Prose html={contact.bodyHtml} className="mt-4" /> : null}
          <div className="mt-6 rounded-lg border border-border bg-bg-elevated p-5">
            <h2 className="text-base font-semibold">Contact details</h2>
            {hasDetails ? (
              <dl className="mt-2 space-y-2 text-sm">
                {email ? (
                  <div>
                    <dt className="text-fg-muted">Email</dt>
                    <dd>
                      <a href={`mailto:${email}`} className="text-primary underline">
                        {email}
                      </a>
                    </dd>
                  </div>
                ) : null}
                {phone ? (
                  <div>
                    <dt className="text-fg-muted">Phone</dt>
                    <dd>
                      <a href={`tel:${phone.replace(/\s+/g, '')}`} className="text-primary underline">
                        {phone}
                      </a>
                    </dd>
                  </div>
                ) : null}
                {whatsapp ? (
                  <div>
                    <dt className="text-fg-muted">WhatsApp</dt>
                    <dd>{whatsapp}</dd>
                  </div>
                ) : null}
                {address ? (
                  <div>
                    <dt className="text-fg-muted">Address</dt>
                    <dd>{address}</dd>
                  </div>
                ) : null}
                {hours ? (
                  <div>
                    <dt className="text-fg-muted">Hours (Africa/Lagos)</dt>
                    <dd>{hours}</dd>
                  </div>
                ) : null}
                {responseTime ? (
                  <div>
                    <dt className="text-fg-muted">Typical response</dt>
                    <dd>{responseTime}</dd>
                  </div>
                ) : null}
              </dl>
            ) : (
              <p className="mt-2 text-sm text-fg-muted">{CONTACT_FALLBACK} Use the form to reach the team by email.</p>
            )}
          </div>
          <p className="mt-4 text-sm text-fg-muted">
            Existing customers can also message their team from the{' '}
            <Link href="/sign-in" className="text-primary underline">
              portal
            </Link>
            .
          </p>
        </div>
        <div className="rounded-lg border border-border bg-bg-elevated p-5 sm:p-6">
          <h2 className="text-xl font-semibold">Send a message</h2>
          <div className="mt-4">
            <ConsultationForm services={services} prefill={readPrefill(params)} variant="contact" />
          </div>
        </div>
      </div>
    </>
  );
}
