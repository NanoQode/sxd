import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { ThemeProvider } from '@simplexd/ui/theme';
import { themeInitScript } from '@simplexd/ui/theme';
import { getIdentity } from '@/lib/auth/session';
import { AppProviders } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'SimplexD', template: '%s · SimplexD' },
  description:
    'Property services and oversight for Nigerians at home and abroad: evidence-backed monitoring, diligence, design, management and market exploration.',
  metadataBase: new URL(process.env.APP_URL ?? 'http://localhost:3000'),
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f6f1' },
    { media: '(prefers-color-scheme: dark)', color: '#151917' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const identity = await getIdentity();
  const serverTheme = identity.profile?.themePreference ?? null;
  const serverMotion = identity.profile ? (identity.profile.reduceMotion ? 'reduce' : null) : null;
  return (
    <html
      lang="en-NG"
      suppressHydrationWarning
      {...(serverTheme && serverTheme !== 'system' ? { 'data-theme-server': serverTheme } : {})}
      {...(serverMotion ? { 'data-motion-server': serverMotion } : {})}
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript() }} />
      </head>
      <body className="min-h-dvh bg-bg text-fg antialiased">
        <AppProviders
          serverTheme={serverTheme}
          serverMotion={serverMotion}
          signedIn={Boolean(identity.session)}
        >
          {children}
        </AppProviders>
      </body>
    </html>
  );
}

export { ThemeProvider };
