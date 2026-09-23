import { CalendarClock, MapPin } from 'lucide-react';
import { StatusBadge, humanize } from '@simplexd/ui';
import { formatInZone } from '@/lib/portal/format';
import type { TenantAppointment } from '@/lib/tenant/model';

const BUSINESS_ZONE = 'Africa/Lagos';

/**
 * Appointments booked for the caller (inspections, repairs, viewings). Times
 * show in Lagos time and, when different, in the caller's own time zone.
 */
export function AppointmentList({
  appointments,
  zone,
}: {
  appointments: TenantAppointment[];
  zone: string;
}) {
  return (
    <ul className="space-y-3">
      {appointments.map((a) => (
        <li key={a.id} className="rounded-lg border border-border bg-bg-elevated p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium break-words">{a.topic ?? humanize(a.kind)}</p>
              <p className="text-xs text-fg-muted">{humanize(a.kind)}</p>
            </div>
            <StatusBadge status={a.status} />
          </div>
          <p className="mt-2 flex items-start gap-2 text-sm">
            <CalendarClock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
            <span>
              <time dateTime={a.startsAt}>{formatInZone(a.startsAt, BUSINESS_ZONE)}</time> –{' '}
              {formatInZone(a.endsAt, BUSINESS_ZONE, 'HH:mm ZZZZ')}
              {zone !== BUSINESS_ZONE ? (
                <span className="block text-xs text-fg-muted">
                  Your time: {formatInZone(a.startsAt, zone)}
                </span>
              ) : null}
            </span>
          </p>
          {a.locationNote ? (
            <p className="mt-1 flex items-start gap-2 text-sm text-fg-muted">
              <MapPin aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="break-words">{a.locationNote}</span>
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
