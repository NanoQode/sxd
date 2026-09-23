import { ErrorState } from '@/components/portal/error-state';
import type { LoadFailure } from '@/lib/tenant/server/load';
import { RefreshButton } from './refresh-button';

/**
 * A section that could not load: says what is missing, shows the reference
 * support can look up, and offers a working retry. Other sections of the
 * page still render (partial state rather than a blank page).
 */
export function LoadError({
  title,
  error,
  className,
}: {
  title: string;
  error: LoadFailure;
  className?: string;
}) {
  return (
    <ErrorState
      className={className}
      title={title}
      message={error.message}
      correlationId={error.correlationId}
      action={<RefreshButton />}
    />
  );
}
