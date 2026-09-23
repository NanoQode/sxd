import { useId, type ReactNode } from 'react';
import { cn } from '../cn';
import { Label } from './label';

export interface FieldProps {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** Accessible form field: label, hint and error wiring via aria-describedby. */
export function Field({ label, htmlFor, hint, error, required, className, children }: FieldProps) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint ? (
        <p id={hintId} className="text-sm text-fg-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Error summary for forms: lists errors with links to the fields. */
export function ErrorSummary({
  errors,
  title = 'Please fix the following',
}: {
  errors: Array<{ id: string; message: string }>;
  title?: string;
}) {
  if (errors.length === 0) return null;
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="rounded-md border border-danger bg-danger-soft p-3 text-sm"
    >
      <p className="font-medium">{title}</p>
      <ul className="mt-1 list-disc pl-5">
        {errors.map((e) => (
          <li key={e.id}>
            <a href={`#${e.id}`} className="underline">
              {e.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
