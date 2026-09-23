import {
  forwardRef,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../cn';

const base =
  'sx-transition w-full rounded-md border border-border-strong bg-bg-elevated px-3 text-fg placeholder:text-fg-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:opacity-60 aria-[invalid=true]:border-danger';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input ref={ref} className={cn(base, 'h-11 text-base sm:text-sm', className)} {...props} />
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(base, 'min-h-28 py-2 text-base sm:text-sm', className)}
      {...props}
    />
  );
});

export type NativeSelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(function NativeSelect(
  { className, ...props },
  ref,
) {
  return (
    <select ref={ref} className={cn(base, 'h-11 text-base sm:text-sm', className)} {...props} />
  );
});
