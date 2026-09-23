'use client';

import { RotateCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@simplexd/ui';

/** Re-runs the server render of the current page (fresh reads, client state kept). */
export function RefreshButton({ label = 'Try again' }: { label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      loading={pending}
      loadingLabel="Loading"
      onClick={() => startTransition(() => router.refresh())}
    >
      <RotateCw aria-hidden="true" className="h-4 w-4" />
      {label}
    </Button>
  );
}
