import type { ReactNode } from 'react';
import { cn } from '../cn';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  /** Shown as the label in the mobile card layout. */
  mobileLabel?: string;
  hideOnMobile?: boolean;
}

/**
 * Responsive table: horizontal scroll with retained row labels on desktop,
 * stacked cards on narrow screens. Rows keep an accessible name via `rowLabel`.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowLabel,
  caption,
  emptyMessage = 'No records',
  className,
  onRowClick,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowLabel: (row: T) => string;
  caption?: string;
  emptyMessage?: ReactNode;
  className?: string;
  onRowClick?: (row: T) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-fg-muted">
        {emptyMessage}
      </p>
    );
  }
  return (
    <div className={cn('w-full', className)}>
      <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
        <table className="w-full min-w-[640px] text-sm">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead className="bg-bg-sunken text-left text-xs uppercase tracking-wide text-fg-muted">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn('px-3 py-2 font-medium', c.className)}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={cn(
                  'border-t border-border',
                  onRowClick && 'cursor-pointer hover:bg-bg-sunken',
                )}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((c, i) => (
                  <td
                    key={c.key}
                    className={cn('px-3 py-2 align-top', c.className)}
                    {...(i === 0 ? { 'aria-label': rowLabel(row) } : {})}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden" aria-label={caption}>
        {rows.map((row) => (
          <li
            key={rowKey(row)}
            className="rounded-lg border border-border bg-bg-elevated p-3"
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            <p className="mb-2 font-medium wrap-anywhere">{rowLabel(row)}</p>
            <dl className="grid grid-cols-[minmax(0,40%)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              {columns
                .filter((c) => !c.hideOnMobile)
                .map((c) => (
                  <div key={c.key} className="contents">
                    <dt className="text-fg-muted wrap-anywhere">{c.mobileLabel ?? c.header}</dt>
                    <dd className="min-w-0 wrap-anywhere">{c.cell(row)}</dd>
                  </div>
                ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
