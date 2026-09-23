import { CalendarDays } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, PageHeader } from '@simplexd/ui';
import { AppointmentList } from '@/components/tenant/appointment-list';
import { LoadError } from '@/components/tenant/load-error';
import { requireSignedIn } from '@/lib/auth/session';
import { splitAppointments } from '@/lib/tenant/model';
import { loadAppointments, zoneOf } from '@/lib/tenant/server/data';

export const metadata: Metadata = { title: 'Appointments' };
export const dynamic = 'force-dynamic';

/** Visits booked with the caller (inspections, repairs, viewings), upcoming first. */
export default async function TenantAppointmentsPage() {
  const identity = await requireSignedIn('/tenant/appointments');
  const zone = zoneOf(identity);
  const appointments = await loadAppointments(identity);
  const split = appointments.ok ? splitAppointments(appointments.data) : null;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/tenant" className="underline">
            Tenant home
          </Link>
        }
        title="Appointments"
        description="Inspections, repair visits and meetings booked with you. Times are shown in Lagos time, and in your own time zone when it differs. To move or cancel a visit, reply to its confirmation or contact your property manager."
      />
      {!appointments.ok ? (
        <LoadError title="Your appointments could not be loaded" error={appointments.error} />
      ) : split && split.upcoming.length === 0 && split.past.length === 0 ? (
        <EmptyState
          icon={<CalendarDays aria-hidden="true" className="h-8 w-8" />}
          title="No appointments"
          description="When an inspection or repair visit is booked with you, it appears here."
        />
      ) : split ? (
        <>
          <section aria-labelledby="upcoming-heading" className="space-y-3">
            <h2 id="upcoming-heading" className="text-lg font-semibold">
              Upcoming ({split.upcoming.length})
            </h2>
            {split.upcoming.length === 0 ? (
              <p className="text-sm text-fg-muted">Nothing upcoming.</p>
            ) : (
              <AppointmentList appointments={split.upcoming} zone={zone} />
            )}
          </section>
          {split.past.length > 0 ? (
            <section aria-labelledby="past-heading" className="space-y-3">
              <h2 id="past-heading" className="text-lg font-semibold">
                Past and cancelled ({split.past.length})
              </h2>
              <AppointmentList appointments={split.past} zone={zone} />
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
