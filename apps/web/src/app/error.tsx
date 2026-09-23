'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { Button, buttonVariants } from '@simplexd/ui';

/** Route-level error boundary: honest message, retry and a way out. */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('route error', error.digest ?? error.message);
  }, [error]);
  return (
    <div className="sx-container flex min-h-[60vh] flex-col items-start justify-center py-16">
      <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">Something went wrong</p>
      <h1 className="font-display mt-1 text-3xl font-semibold">This page could not be shown</h1>
      <p className="mt-2 max-w-prose text-fg-muted">
        The server reported an error while rendering this page. No data has been invented in its
        place. You can try again or go back to the homepage.
      </p>
      {error.digest ? (
        <p className="mt-2 text-xs text-fg-subtle">
          Quote this reference to support: <code className="font-mono">{error.digest}</code>
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button onClick={() => reset()}>Try again</Button>
        <Link href="/" className={buttonVariants({ variant: 'secondary' })}>
          Homepage
        </Link>
        <Link href="/contact" className={buttonVariants({ variant: 'ghost' })}>
          Contact
        </Link>
      </div>
    </div>
  );
}
