import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../cn';
import { Spinner } from './spinner';

export const buttonVariants = cva(
  'sx-transition inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap select-none disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus active:scale-[0.98]',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-fg-on-primary hover:bg-primary-hover shadow-sm',
        secondary: 'bg-bg-elevated text-fg border border-border-strong hover:bg-bg-sunken',
        ghost: 'bg-transparent text-fg hover:bg-bg-sunken',
        accent: 'bg-gold text-fg-on-accent hover:brightness-95 shadow-sm',
        danger: 'bg-danger text-white hover:brightness-95',
        link: 'bg-transparent text-primary underline underline-offset-4 hover:text-primary-hover px-0',
      },
      size: {
        sm: 'h-9 px-3 text-sm',
        md: 'h-11 px-4 text-sm',
        lg: 'h-12 px-6 text-base',
        icon: 'h-11 w-11 p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
  loadingLabel?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    loading,
    loadingLabel,
    children,
    disabled,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <Spinner className="h-4 w-4" />
          <span>{loadingLabel ?? children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
});
