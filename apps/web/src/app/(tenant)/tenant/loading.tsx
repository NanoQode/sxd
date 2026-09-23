import { Skeleton } from '@simplexd/ui';

/** Shown only while the server is actually loading the next tenant page. */
export default function TenantLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <p className="sr-only">Loading your tenant information…</p>
      <div className="space-y-2">
        <Skeleton className="h-8 w-2/3 max-w-sm" label="Loading page title" />
        <Skeleton className="h-4 w-full max-w-lg" label="Loading description" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-36 w-full" label="Loading section" />
        <Skeleton className="h-36 w-full" label="Loading section" />
      </div>
      <Skeleton className="h-48 w-full" label="Loading list" />
    </div>
  );
}
