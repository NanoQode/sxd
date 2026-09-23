import Link from 'next/link';
import type { ReactNode } from 'react';
import { ThemeToggle } from '@simplexd/ui';

export const metadata = { robots: { index: false, follow: false } };

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sx-container flex h-16 items-center justify-between">
        <Link href="/" className="font-display text-lg font-semibold">
          SimplexD
        </Link>
        <ThemeToggle compact />
      </header>
      <main className="sx-container flex flex-1 items-start justify-center py-8 sm:items-center">
        <div className="w-full max-w-md">{children}</div>
      </main>
      <footer className="sx-container py-6 text-center text-xs text-fg-subtle">
        <Link href="/policies/privacy" className="underline">
          Privacy
        </Link>
        {' · '}
        <Link href="/policies/terms" className="underline">
          Terms
        </Link>
      </footer>
    </div>
  );
}
