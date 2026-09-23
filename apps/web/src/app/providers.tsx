'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { useState, type ReactNode } from 'react';
import { ThemeProvider, type MotionPreference, type ThemePreference } from '@simplexd/ui/theme';
import { ToastProvider } from '@simplexd/ui';

export function AppProviders({
  children,
  serverTheme,
  serverMotion,
  signedIn,
}: {
  children: ReactNode;
  serverTheme: ThemePreference | null;
  serverMotion: MotionPreference | null;
  signedIn: boolean;
}) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 1 } } }),
  );
  const persist = signedIn
    ? async (prefs: { theme: ThemePreference; motion: MotionPreference }) => {
        await fetch('/api/v1/me/preferences', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            themePreference: prefs.theme,
            reduceMotion: prefs.motion === 'reduce',
          }),
        }).catch(() => undefined);
      }
    : undefined;
  return (
    <QueryClientProvider client={client}>
      <NuqsAdapter>
        <ThemeProvider serverTheme={serverTheme} serverMotion={serverMotion} onPersist={persist}>
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </NuqsAdapter>
    </QueryClientProvider>
  );
}
