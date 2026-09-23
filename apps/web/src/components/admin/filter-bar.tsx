import type { ReactNode } from 'react';
import { NativeSelect, cn } from '@simplexd/ui';

/**
 * GET-form filter bar for server-rendered tables: the URL is the state, so
 * filters survive reloads, are shareable and can be saved as views.
 */
export function FilterBar({
  children,
  className,
  submitLabel = 'Filter',
  hidden,
}: {
  children: ReactNode;
  className?: string;
  submitLabel?: string;
  /** Hidden fields kept across submissions (e.g. tab). */
  hidden?: Record<string, string | undefined>;
}) {
  return (
    <form
      method="get"
      className={cn(
        'grid gap-3 rounded-lg border border-border bg-bg-elevated p-4 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(160px,1fr))] lg:items-end',
        className,
      )}
    >
      {hidden
        ? Object.entries(hidden)
            .filter(([, v]) => v)
            .map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)
        : null}
      {children}
      <button
        type="submit"
        className="sx-touch rounded-md border border-border-strong px-4 text-sm font-medium hover:bg-bg-sunken"
      >
        {submitLabel}
      </button>
    </form>
  );
}

export function FilterSelect({
  name,
  label,
  value,
  options,
  allLabel = 'Any',
}: {
  name: string;
  label: string;
  value: string | undefined;
  options: Array<{ value: string; label: string }>;
  allLabel?: string;
}) {
  return (
    <label className="text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <NativeSelect name={name} defaultValue={value ?? ''}>
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}

export function FilterInput({
  name,
  label,
  value,
  placeholder,
  type = 'text',
}: {
  name: string;
  label: string;
  value: string | undefined;
  placeholder?: string;
  type?: 'text' | 'date' | 'number';
}) {
  return (
    <label className="text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <input
        type={type}
        name={name}
        defaultValue={value ?? ''}
        placeholder={placeholder}
        className="h-11 w-full rounded-md border border-border-strong bg-bg-elevated px-3 text-sm"
      />
    </label>
  );
}

export function FilterCheckbox({
  name,
  label,
  checked,
}: {
  name: string;
  label: string;
  checked: boolean;
}) {
  return (
    <label className="flex h-11 items-center gap-2 text-sm">
      <input type="checkbox" name={name} value="1" defaultChecked={checked} className="h-4 w-4" />
      <span>{label}</span>
    </label>
  );
}
