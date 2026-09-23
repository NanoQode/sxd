'use client';

import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, Badge, Button, Skeleton, formatDateTimeLabel } from '@simplexd/ui';
import { describeApiFailure, useServerNow } from '@/lib/partner/api';

/** Skeleton rows while a real request is in flight. */
export function LoadingBlock({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" label={i === 0 ? label : ''} />
      ))}
    </div>
  );
}

/** Honest failure state: names the reason and offers a retry when it makes sense. */
export function RequestFailed({
  error,
  onRetry,
  context,
}: {
  error: unknown;
  onRetry?: () => void;
  context?: string;
}) {
  const d = describeApiFailure(error);
  const retryable =
    d.code === 'network' ||
    d.code === 'offline' ||
    d.code === 'rate_limited' ||
    d.code === 'internal_error';
  return (
    <Alert
      tone={d.code === 'feature_disabled' || d.code === 'forbidden' ? 'info' : 'danger'}
      title={context ? `${context}: ${d.title}` : d.title}
    >
      <p>{d.detail}</p>
      {retryable && onRetry ? (
        <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </Alert>
  );
}

/** A control that cannot work yet, with the real dependency spelled out. */
export function NotAvailable({
  title,
  reason,
  children,
}: {
  title: string;
  reason: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-dashed border-border p-4 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <Info aria-hidden="true" className="h-4 w-4 text-fg-muted" />
        {title}
      </p>
      <p className="mt-1 text-fg-muted">Not available: {reason}</p>
      {children}
    </div>
  );
}

/** Timestamp shown in the working zone and in UTC. */
export function DualTime({ iso, zone }: { iso: string | null | undefined; zone: string }) {
  if (!iso) return <span className="text-fg-muted">—</span>;
  return (
    <span>
      {formatDateTimeLabel(iso, zone)}
      {/* The UTC label already ends in "UTC". */}
      <span className="block text-xs text-fg-muted">{formatDateTimeLabel(iso, 'UTC')}</span>
    </span>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'passed';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m`;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

/**
 * Countdown against the server clock. While no API response has been seen
 * the device clock is used and the label says so.
 */
export function DeadlineCountdown({
  deadlineIso,
  label = 'Closes in',
}: {
  deadlineIso: string | null;
  label?: string;
}) {
  const { now, known } = useServerNow();
  if (!deadlineIso) return <Badge tone="neutral">No deadline set</Badge>;
  const remaining = new Date(deadlineIso).getTime() - now.getTime();
  const passed = remaining <= 0;
  const urgent = !passed && remaining < 60 * 60 * 1000;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge tone={passed ? 'danger' : urgent ? 'warning' : 'primary'} role="timer" aria-live="off">
        {passed ? 'Deadline passed' : `${label} ${formatRemaining(remaining)}`}
      </Badge>
      <span className="text-xs text-fg-muted">
        {known ? 'server clock' : 'device clock until the server responds'}
      </span>
    </span>
  );
}

/** Key/value rows for detail panels. */
export function DetailList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className="text-xs uppercase tracking-wide text-fg-muted">{it.label}</dt>
          <dd className="mt-0.5 break-words">{it.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
