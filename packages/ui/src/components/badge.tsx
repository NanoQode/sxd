import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../cn';

export const badgeVariants = cva(
  // Long labels wrap on narrow screens instead of pushing the page sideways.
  'inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-normal sm:whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-bg-sunken text-fg-muted',
        primary: 'border-transparent bg-primary-soft text-primary',
        success: 'border-transparent bg-success-soft text-success',
        warning: 'border-transparent bg-warning-soft text-warning',
        danger: 'border-transparent bg-danger-soft text-danger',
        info: 'border-transparent bg-info-soft text-info',
        gold: 'border-transparent bg-gold-soft text-fg',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
