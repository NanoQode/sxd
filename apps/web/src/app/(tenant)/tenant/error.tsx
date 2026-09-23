'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { Button, buttonVariants } from '@simplexd/ui';

/** Unexpected failure inside the tenant area: honest message, reference, retry and a way home. */
export default function TenantError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error('tenant route error', error.digest ?? error.message);
  }, [error]);
  return (
    <div role="alert" className="space-y-3 rounded-lg border border-danger/40 bg-danger-soft p-5">
      <h1 className="font-display text-2xl font-semibold">This page could not be shown</h1>
      <p className="max-w-prose text-sm text-fg-muted">
        The server reported an error while loading your tenant information. Nothing has been guessed
        or filled in its place. Try again, or go back to your tenant home.
      </p>
      {error.digest ? (
        <p className="text-xs text-fg-subtle">
          Reference for support: <code className="font-mono">{error.digest}</code>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => retry()}>Try again</Button>
        <Link href="/tenant" className={buttonVariants({ variant: 'secondary' })}>
          Tenant home
        </Link>
      </div>
    </div>
  );
}
