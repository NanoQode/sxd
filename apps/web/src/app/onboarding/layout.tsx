import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ThemeToggle } from '@simplexd/ui';

export const metadata: Metadata = { title: 'Get started', robots: { index: false, follow: false } };

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sx-container flex h-16 items-center justify-between">
        <Link href="/" className="font-display text-lg font-semibold">
          SimplexD
        </Link>
        <ThemeToggle compact />
      </header>
      <main className="sx-container flex flex-1 items-start justify-center py-8">
        <div className="w-full max-w-2xl">{children}</div>
      </main>
    </div>
  );
}
