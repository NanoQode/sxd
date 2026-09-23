import { AlertTriangle, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { WorkOrderDto } from '@simplexd/contracts';
import { formatDateTimeLabel } from '@simplexd/ui';
import { categoryLabel } from '@/lib/tenant/model';
import { PriorityBadge, TicketStatusBadge } from './status';

/** The caller's maintenance tickets as keyboard-friendly links to their detail pages. */
export function TicketList({
  tickets,
  zone,
  leaseTitles,
}: {
  tickets: WorkOrderDto[];
  zone: string;
  /** Lease id → readable property/unit title, when the caller has several leases. */
  leaseTitles?: Record<string, string>;
}) {
  return (
    <ul className="space-y-2">
      {tickets.map((t) => (
        <li key={t.id}>
          <Link
            href={`/tenant/tickets/${t.id}`}
            className="sx-transition flex items-start gap-3 rounded-lg border border-border bg-bg-elevated p-3 hover:bg-bg-sunken"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-medium break-words">{t.title}</p>
              <div className="flex flex-wrap items-center gap-2">
                <TicketStatusBadge status={t.status} />
                <PriorityBadge priority={t.priority} />
                {t.slaBreached ? (
                  <span className="inline-flex items-center gap-1 text-xs text-warning">
                    <AlertTriangle aria-hidden="true" className="h-3 w-3" />
                    Response target passed
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-fg-muted">
                {categoryLabel(t.category)} · Reported{' '}
                <time dateTime={t.createdAt}>{formatDateTimeLabel(t.createdAt, zone)}</time>
                {leaseTitles && t.leaseId && leaseTitles[t.leaseId]
                  ? ` · ${leaseTitles[t.leaseId]}`
                  : ''}
              </p>
            </div>
            <ChevronRight aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-fg-muted" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
