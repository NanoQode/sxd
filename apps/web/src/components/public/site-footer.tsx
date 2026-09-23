import Link from 'next/link';
import type { PublishedContent } from '@simplexd/contracts';
import { Badge } from '@simplexd/ui';
import { CONTACT_FALLBACK, SITE } from './defaults';
import { FooterControls } from './footer-controls';
import type { NavServiceItem } from './nav-data';

export interface FooterData {
  services: NavServiceItem[];
  contact: PublishedContent | null;
  policies: { privacy: PublishedContent | null; terms: PublishedContent | null };
}

function policyReviewed(page: PublishedContent | null): boolean {
  return page?.fields.reviewStatus === 'reviewed';
}

function contactField(page: PublishedContent | null, key: string): string | null {
  const v = page?.fields[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function SiteFooter({ services, contact, policies }: FooterData) {
  const email = contactField(contact, 'email');
  const phone = contactField(contact, 'phone');
  const whatsapp = contactField(contact, 'whatsapp');
  const address = contactField(contact, 'address');
  const hours = contactField(contact, 'hours');
  const hasContact = Boolean(email || phone || whatsapp || address);
  const pendingReview = !policyReviewed(policies.privacy) || !policyReviewed(policies.terms);
  const year = new Date().getFullYear();

  return (
    <footer className="mt-auto border-t border-border bg-bg-sunken">
      <div className="sx-container grid gap-8 py-10 sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <p className="font-display text-lg font-semibold">
            Simplex<span className="text-primary">D</span>
          </p>
          <p className="mt-2 max-w-sm text-sm text-fg-muted">{SITE.tagline}</p>
          <p className="mt-2 max-w-sm text-xs text-fg-subtle">
            Map coverage and service availability are separate facts: a location on the map does not
            imply a staffed operation there.
          </p>
          <div className="mt-4" aria-label="Contact details">
            <h2 className="text-sm font-semibold">Contact</h2>
            {hasContact ? (
              <ul className="mt-1 space-y-1 text-sm text-fg-muted">
                {email ? (
                  <li>
                    <a href={`mailto:${email}`} className="hover:text-fg hover:underline">
                      {email}
                    </a>
                  </li>
                ) : null}
                {phone ? (
                  <li>
                    <a
                      href={`tel:${phone.replace(/\s+/g, '')}`}
                      className="hover:text-fg hover:underline"
                    >
                      {phone}
                    </a>
                  </li>
                ) : null}
                {whatsapp ? <li>WhatsApp: {whatsapp}</li> : null}
                {address ? <li>{address}</li> : null}
                {hours ? <li>{hours}</li> : null}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-fg-muted">{CONTACT_FALLBACK}</p>
            )}
            <Link href="/contact" className="mt-1 inline-block text-sm text-primary underline">
              Contact page
            </Link>
          </div>
        </div>
        <nav aria-label="Services" className="text-sm">
          <h2 className="font-semibold">Services</h2>
          <ul className="mt-2 space-y-1.5">
            {services.map((s) => (
              <li key={s.slug}>
                <Link
                  href={`/services/${s.slug}`}
                  className="text-fg-muted hover:text-fg hover:underline"
                >
                  {s.name}
                </Link>
              </li>
            ))}
            <li>
              <Link href="/pricing" className="text-fg-muted hover:text-fg hover:underline">
                Pricing
              </Link>
            </li>
            <li>
              <Link
                href="/services#planned"
                className="text-fg-muted hover:text-fg hover:underline"
              >
                Planned services
              </Link>
            </li>
          </ul>
        </nav>
        <nav aria-label="Explore" className="text-sm">
          <h2 className="font-semibold">Explore</h2>
          <ul className="mt-2 space-y-1.5">
            {[
              ['/explore', 'Location explorer'],
              ['/locations', 'All locations'],
              ['/properties', 'Properties'],
              ['/projects', 'Projects'],
              ['/resources', 'Resources'],
              ['/how-it-works', 'How it works'],
              ['/diaspora', 'For the diaspora'],
              ['/local-nigeria', 'For local owners'],
            ].map(([href, label]) => (
              <li key={href}>
                <Link href={href!} className="text-fg-muted hover:text-fg hover:underline">
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Company and policies" className="text-sm">
          <h2 className="font-semibold">Company</h2>
          <ul className="mt-2 space-y-1.5">
            <li>
              <Link href="/about" className="text-fg-muted hover:text-fg hover:underline">
                About
              </Link>
            </li>
            <li>
              <Link href="/book" className="text-fg-muted hover:text-fg hover:underline">
                Book a consultation
              </Link>
            </li>
            <li>
              <Link href="/sign-in" className="text-fg-muted hover:text-fg hover:underline">
                Sign in
              </Link>
            </li>
            <li>
              <Link
                href="/policies/privacy"
                className="text-fg-muted hover:text-fg hover:underline"
              >
                Privacy notice
              </Link>
            </li>
            <li>
              <Link href="/policies/terms" className="text-fg-muted hover:text-fg hover:underline">
                Terms of service
              </Link>
            </li>
          </ul>
          {pendingReview ? (
            <p className="mt-3">
              <Badge tone="warning">Policies: template pending legal review</Badge>
            </p>
          ) : null}
        </nav>
      </div>
      <div className="border-t border-border">
        <div className="sx-container flex flex-col gap-4 py-6 md:flex-row md:items-center md:justify-between">
          <FooterControls />
          <p className="text-xs text-fg-subtle">
            © {year} {SITE.name}. Timestamps are stored in UTC and shown in Africa/Lagos and your
            time zone.
          </p>
        </div>
      </div>
    </footer>
  );
}
