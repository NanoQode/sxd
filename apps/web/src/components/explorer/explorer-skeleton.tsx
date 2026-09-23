import { Skeleton } from '@simplexd/ui';
import type { ExplorerVariant } from '@/lib/explorer';
import { MAP_HEIGHT_CLASS } from './layout-constants';

/** Reserved-height placeholder shown only while the explorer is actually loading. */
export function ExplorerSkeleton({ variant }: { variant: ExplorerVariant }) {
  const mapHeight = MAP_HEIGHT_CLASS[variant];
  return (
    <div
      role="status"
      aria-label="Loading the location explorer"
      className="rounded-lg border border-border bg-bg-elevated p-4"
    >
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-11 w-40" />
        <Skeleton className="h-11 w-32" />
        <Skeleton className="h-11 w-24" />
      </div>
      <div className={variant === 'full' ? 'mt-4 grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)_360px]' : 'mt-4'}>
        {variant === 'full' ? <Skeleton className="hidden h-96 lg:block" /> : null}
        <Skeleton className={`${mapHeight} w-full rounded-lg`} label="Loading map" />
        {variant === 'full' ? <Skeleton className="hidden h-96 lg:block" /> : null}
      </div>
    </div>
  );
}
