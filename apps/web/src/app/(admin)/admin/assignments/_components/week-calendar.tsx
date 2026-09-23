import Link from 'next/link';
import { DateTime } from 'luxon';
import { Badge } from '@simplexd/ui';
import type { CalendarEntry } from '@/lib/admin/server/workload';

const ZONE = 'Africa/Lagos';

/** Seven-column week grid (stacked on narrow screens) of appointments and site visits. */
export function WeekCalendar({
  weekStartIso,
  entries,
}: {
  weekStartIso: string;
  entries: CalendarEntry[];
}) {
  const start = DateTime.fromISO(weekStartIso, { zone: 'utc' }).setZone(ZONE).startOf('day');
  const days = Array.from({ length: 7 }, (_, i) => start.plus({ days: i }));
  return (
    <div className="grid gap-2 md:grid-cols-7">
      {days.map((day) => {
        const items = entries.filter((e) =>
          DateTime.fromISO(e.startsAt).setZone(ZONE).hasSame(day, 'day'),
        );
        const isToday = day.hasSame(DateTime.now().setZone(ZONE), 'day');
        return (
          <section
            key={day.toISODate()}
            aria-label={day.toFormat('cccc d LLLL')}
            className={`rounded-md border p-2 ${isToday ? 'border-primary' : 'border-border'}`}
          >
            <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">
              {day.toFormat('ccc d LLL')}
              {isToday ? (
                <Badge tone="primary" className="ml-1">
                  today
                </Badge>
              ) : null}
            </h3>
            {items.length === 0 ? (
              <p className="mt-1 text-xs text-fg-subtle">Nothing scheduled</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {items.map((e) => (
                  <li key={`${e.kind}-${e.id}`}>
                    <Link
                      href={e.href}
                      className={`block rounded-md border px-2 py-1 text-xs hover:bg-bg-sunken ${e.kind === 'site_visit' ? 'border-gold/60 bg-gold-soft/40' : 'border-info/40 bg-info-soft/40'}`}
                    >
                      <span className="font-medium">
                        {DateTime.fromISO(e.startsAt).setZone(ZONE).toFormat('HH:mm')}
                      </span>{' '}
                      {e.title}
                      <span className="block text-fg-muted">
                        {e.staffName ?? 'unassigned'} · {e.status.replace(/_/g, ' ')}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
