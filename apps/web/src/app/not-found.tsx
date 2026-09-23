import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonVariants } from '@simplexd/ui';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sx-container flex h-16 items-center">
        <Link href="/" className="font-display text-lg font-semibold">
          Simplex<span className="text-primary">D</span>
        </Link>
      </header>
      <main id="main" className="sx-container flex flex-1 flex-col items-start justify-center py-16">
        <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">404</p>
        <h1 className="font-display mt-1 text-3xl font-semibold">This page does not exist</h1>
        <p className="mt-2 max-w-prose text-fg-muted">
          The address may be mistyped, or the content was unpublished. Nothing here has been
          removed silently: markets, listings and resources only appear when published.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Link href="/" className={buttonVariants()}>
            Go to the homepage
          </Link>
          <Link href="/services" className={buttonVariants({ variant: 'secondary' })}>
            Services
          </Link>
          <Link href="/locations" className={buttonVariants({ variant: 'secondary' })}>
            Locations
          </Link>
          <Link href="/contact" className={buttonVariants({ variant: 'ghost' })}>
            Contact
          </Link>
        </div>
      </main>
    </div>
  );
}
