'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { CONSENT_EVENT, trackEvent } from './analytics';

/** Records a page view per navigation, only after analytics consent. */
export function PageViewTracker() {
  const pathname = usePathname();
  useEffect(() => {
    trackEvent('page_view');
  }, [pathname]);
  useEffect(() => {
    const onConsent = (event: Event) => {
      if ((event as CustomEvent<string>).detail === 'analytics') trackEvent('page_view');
    };
    window.addEventListener(CONSENT_EVENT, onConsent);
    return () => window.removeEventListener(CONSENT_EVENT, onConsent);
  }, []);
  return null;
}
