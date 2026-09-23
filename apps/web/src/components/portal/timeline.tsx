import Link from 'next/link';
import { Badge, EmptyState, formatDateTimeLabel, humanize } from '@simplexd/ui';
import type { TimelineEvent } from '@/lib/portal/server/properties';

/** Chronological list of derived events (newest first) with the record's own timestamp. */
export function Timeline({
  events,
  zone,
  emptyTitle = 'Nothing recorded yet',
  emptyDescription = 'Events appear here as records are created and decided.',
}: {
  events: TimelineEvent[];
  zone: string;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  if (events.length === 0) return <EmptyState title={emptyTitle} description={emptyDescription} />;
  return (
    <ol className="space-y-4 border-l border-border pl-4">
      {events.map((e) => (
        <li key={e.id} className="relative text-sm">
          <span
            aria-hidden="true"
            className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-primary"
          />
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {e.href ? (
                <Link href={e.href} className="underline">
                  {e.title}
                </Link>
              ) : (
                e.title
              )}
            </span>
            <Badge tone="neutral">{humanize(e.kind)}</Badge>
          </p>
          <p className="text-xs text-fg-muted">{formatDateTimeLabel(e.at, zone)}</p>
          {e.detail ? <p className="mt-1 whitespace-pre-wrap text-fg-muted">{e.detail}</p> : null}
        </li>
      ))}
    </ol>
  );
}
