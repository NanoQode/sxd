import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';

const tones = {
  info: { icon: Info, className: 'border-info/40 bg-info-soft text-fg' },
  success: { icon: CheckCircle2, className: 'border-success/40 bg-success-soft text-fg' },
  warning: { icon: AlertTriangle, className: 'border-warning/40 bg-warning-soft text-fg' },
  danger: { icon: XCircle, className: 'border-danger/40 bg-danger-soft text-fg' },
} as const;

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: keyof typeof tones;
  title?: ReactNode;
}

/** Status message with icon plus words (never colour alone). */
export function Alert({ tone = 'info', title, className, children, ...props }: AlertProps) {
  const { icon: Icon, className: toneClass } = tones[tone];
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-md border p-3 text-sm', toneClass, className)}
      {...props}
    >
      <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cn(title && 'mt-0.5', 'text-fg-muted')}>{children}</div> : null}
      </div>
    </div>
  );
}
