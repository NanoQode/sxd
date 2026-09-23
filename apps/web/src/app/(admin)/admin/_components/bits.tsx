import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card, CardContent, cn } from '@simplexd/ui';

/** Small presentational helpers shared by admin pages (server-safe). */

export function StatTile({
  label,
  value,
  href,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  href?: string;
  hint?: ReactNode;
  tone?: 'neutral' | 'warning' | 'danger' | 'success';
}) {
  const body = (
    <Card
      className={cn(
        'h-full',
        tone === 'warning' && 'border-warning/50',
        tone === 'danger' && 'border-danger/50',
        tone === 'success' && 'border-success/50',
      )}
    >
      <CardContent className="p-4 sm:p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</p>
        <p className="mt-1 font-display text-2xl font-semibold">{value}</p>
        {hint ? <p className="mt-1 text-xs text-fg-muted">{hint}</p> : null}
      </CardContent>
    </Card>
  );
  return href ? (
    <Link
      href={href}
      className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      {body}
    </Link>
  ) : (
    body
  );
}

export function DefinitionList({
  items,
  className,
}: {
  items: Array<{ term: ReactNode; value: ReactNode }>;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        'grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]',
        className,
      )}
    >
      {items.map((item, i) => (
        <div key={i} className="contents">
          <dt className="text-fg-muted">{item.term}</dt>
          <dd className="min-w-0 break-words">
            {item.value ?? <span className="text-fg-subtle">—</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="rounded bg-bg-sunken px-1 py-0.5 font-mono text-xs">{children}</code>;
}

export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-border bg-bg-sunken p-2 font-mono text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-NG', {
    timeZone: 'Africa/Lagos',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}
