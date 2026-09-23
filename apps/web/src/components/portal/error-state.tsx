import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@simplexd/ui';

/**
 * Honest failure state. Always shows the correlation id when one exists so a
 * customer can quote it to support; never pretends a partial result is whole.
 */
export function ErrorState({
  title = 'Something did not load',
  message,
  correlationId,
  action,
  className,
}: {
  title?: ReactNode;
  message: ReactNode;
  correlationId?: string | null;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn('rounded-lg border border-danger/40 bg-danger-soft p-4 text-sm', className)}
    >
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle aria-hidden="true" className="h-4 w-4 text-danger" />
        {title}
      </p>
      <div className="mt-1 text-fg-muted">{message}</div>
      {correlationId ? (
        <p className="mt-2 text-xs text-fg-subtle">
          Reference for support: <code className="font-mono">{correlationId}</code>
        </p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/** Explains a real setup dependency instead of rendering a dead control. */
export function NotAvailable({
  what,
  reason,
  className,
}: {
  what: string;
  reason: string;
  className?: string;
}) {
  return (
    <p
      role="status"
      className={cn(
        'rounded-md border border-dashed border-border bg-bg-sunken p-3 text-sm text-fg-muted',
        className,
      )}
    >
      <span className="font-medium text-fg">{what} is not available yet.</span> {reason}
    </p>
  );
}
