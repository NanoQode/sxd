'use client';

import { ReduceMotionToggle, ThemeToggle } from '@simplexd/ui';
import { ConsentPreferencesButton } from './consent-banner';

export function FooterControls() {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <ThemeToggle />
      <ReduceMotionToggle />
      <ConsentPreferencesButton />
    </div>
  );
}
