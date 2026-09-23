import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { getIdentity } from '@/lib/auth/session';
import { ActionBarProvider, StickyActionBar } from '@/components/public/action-bar';
import { CONSENT_COOKIE, parseConsentCookie } from '@/components/public/analytics';
import { ConsentBanner } from '@/components/public/consent-banner';
import { PageViewTracker } from '@/components/public/page-view-tracker';
import { SiteBanners } from '@/components/public/site-banner';
import { SiteFooter } from '@/components/public/site-footer';
import { SiteHeader } from '@/components/public/site-header';
import { contentBySlug, loadBanners, loadNavigation, navServices } from './_lib/site-data';

/**
 * Public website shell: skip link, CMS announcement banners, banner with
 * primary navigation (links from published navigation pages, defaults
 * otherwise), main landmark, footer with policies and contact from the CMS,
 * contextual mobile action bar and the analytics consent sheet. Nothing here
 * tracks before consent.
 */
export default async function PublicLayout({ children }: { children: ReactNode }) {
  const [identity, cookieStore, services, contact, privacy, terms, banners, navigation] =
    await Promise.all([
      getIdentity(),
      cookies(),
      navServices(),
      contentBySlug('contact', 'contact'),
      contentBySlug('privacy', 'policy'),
      contentBySlug('terms', 'policy'),
      loadBanners(),
      loadNavigation(),
    ]);
  const consentRaw = cookieStore.get(CONSENT_COOKIE)?.value;
  const consent = consentRaw ? parseConsentCookie(`${CONSENT_COOKIE}=${consentRaw}`) : null;

  return (
    <ActionBarProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:border focus:border-border focus:bg-bg-elevated focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg"
      >
        Skip to content
      </a>
      <div className="flex min-h-dvh flex-col">
        <SiteBanners banners={banners} />
        <SiteHeader
          services={services}
          signedIn={Boolean(identity.session)}
          primaryLinks={navigation.primary}
          secondaryLinks={navigation.secondary}
        />
        <main id="main" tabIndex={-1} className="flex-1 pb-24 outline-none md:pb-0">
          {children}
        </main>
        <SiteFooter
          services={services}
          contact={contact}
          policies={{ privacy, terms }}
          exploreLinks={navigation.footerExplore}
          companyLinks={navigation.footerCompany}
        />
      </div>
      <StickyActionBar />
      <ConsentBanner initialConsent={consent} />
      <PageViewTracker />
    </ActionBarProvider>
  );
}
