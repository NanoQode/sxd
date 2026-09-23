import type { ReactNode } from 'react';
import { cn } from '../cn';

/** Honest empty/partial/unauthorized/offline states with a next action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  tone = 'neutral',
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  tone?: 'neutral' | 'warning' | 'danger';
}) {
  return (
    <div
      role={tone === 'neutral' ? undefined : 'status'}
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center',
        tone === 'warning' && 'border-warning/50 bg-warning-soft/40',
        tone === 'danger' && 'border-danger/50 bg-danger-soft/40',
        tone === 'neutral' && 'border-border',
        className,
      )}
    >
      {icon ? <div className="text-fg-muted">{icon}</div> : null}
      <p className="font-medium">{title}</p>
      {description ? <p className="max-w-prose text-sm text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
