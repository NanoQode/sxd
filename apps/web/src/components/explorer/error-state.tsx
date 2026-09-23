import { Alert, Button } from '@simplexd/ui';
import { describeError } from '@/lib/explorer';

/** Failure state with the reason, the support reference and a retry action. */
export function ErrorState({
  title,
  error,
  onRetry,
  retryLabel = 'Try again',
  className,
}: {
  title: string;
  error: unknown;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  const described = describeError(error);
  return (
    <Alert tone="danger" title={title} className={className}>
      <p>{described.message}</p>
      {described.correlationId ? (
        <p className="mt-1 text-xs">Support reference: {described.correlationId}</p>
      ) : null}
      {onRetry ? (
        <div className="mt-2">
          <Button variant="secondary" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </Alert>
  );
}
