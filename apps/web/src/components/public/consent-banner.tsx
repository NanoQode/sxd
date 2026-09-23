'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { Button } from '@simplexd/ui';
import { writeConsent, type ConsentChoice } from './analytics';

export const CONSENT_OPEN_EVENT = 'sx:consent-open';

/**
 * Analytics consent bottom sheet. Non-modal, dismissible, keyboard reachable.
 * No analytics request is made before a choice is stored in the sx_consent
 * cookie; "Essential only" is a full answer, not a nag.
 */
export function ConsentBanner({ initialConsent }: { initialConsent: ConsentChoice | null }) {
  const [visible, setVisible] = useState(initialConsent === null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const reopen = () => setVisible(true);
    window.addEventListener(CONSENT_OPEN_EVENT, reopen);
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, reopen);
  }, []);

  if (!visible) return null;

  const choose = (choice: ConsentChoice) => {
    writeConsent(choice);
    setVisible(false);
  };

  return (
    <section
      role="region"
      aria-labelledby={titleId}
      aria-describedby={descId}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg-elevated p-4 shadow-lg sm:inset-x-auto sm:right-4 sm:bottom-4 sm:max-w-md sm:rounded-lg sm:border"
    >
      <h2 id={titleId} className="text-base font-semibold">
        Analytics consent
      </h2>
      <p id={descId} className="mt-1 text-sm text-fg-muted">
        With your permission we record page views and form completions to improve this site.
        Events never include your email, documents or payment details, and nothing is sent
        before you choose. Read the{' '}
        <Link href="/policies/privacy" className="text-primary underline">
          privacy notice
        </Link>
        .
      </p>
      <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={() => choose('essential')}>
          Essential only
        </Button>
        <Button onClick={() => choose('analytics')}>Allow analytics</Button>
      </div>
    </section>
  );
}

/** Footer control to revisit the choice later. */
export function ConsentPreferencesButton() {
  return (
    <button
      type="button"
      className="sx-touch inline-flex items-center text-sm underline underline-offset-4 hover:text-fg"
      onClick={() => window.dispatchEvent(new Event(CONSENT_OPEN_EVENT))}
    >
      Analytics preferences
    </button>
  );
}
