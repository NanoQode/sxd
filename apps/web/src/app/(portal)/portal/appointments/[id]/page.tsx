import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  StatusBadge,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { AppointmentActions } from '@/components/portal/appointment-actions';
import { viewerFromIdentity } from '@/server/appointments/access';
import { getAppointment } from '@/server/appointments/queries';

export const metadata: Metadata = { title: 'Appointment' };
export const dynamic = 'force-dynamic';

export default async function AppointmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const identity = await requireSignedIn(`/portal/appointments/${id}`);
  const appointment = await getAppointment(viewerFromIdentity(identity), id).catch((err) => {
    if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden'))
      return null;
    throw err;
  });
  if (!appointment) notFound();
  const zone = identity.profile?.timeZone ?? appointment.customerTimeZone;
  const isStaff = identity.actor.staffRoles.length > 0;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/portal/appointments" className="underline">
            Appointments
          </Link>
        }
        title={`${humanize(appointment.kind)}${appointment.topic ? `: ${appointment.topic}` : ''}`}
        description={`With ${appointment.staff.name}`}
        actions={<StatusBadge status={appointment.status} />}
      />
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>When</CardTitle>
            <CardDescription>
              UTC instant {appointment.startsAt} to {appointment.endsAt}; labels below follow each
              zone&apos;s daylight-saving rules.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-fg-muted">Your time ({appointment.customerTimeZone})</dt>
                <dd className="text-base font-medium">{appointment.label.customer}</dd>
              </div>
              <div>
                <dt className="text-fg-muted">Business time ({appointment.businessTimeZone})</dt>
                <dd className="text-base font-medium">{appointment.label.business}</dd>
              </div>
              {appointment.label.dateDiffers ? (
                <div className="sm:col-span-2">
                  <dd className="text-xs text-fg-muted">
                    The calendar date differs between the two zones.
                  </dd>
                </div>
              ) : null}
              {appointment.notes ? (
                <div className="sm:col-span-2">
                  <dt className="text-fg-muted">Notes</dt>
                  <dd className="whitespace-pre-wrap">{appointment.notes}</dd>
                </div>
              ) : null}
            </dl>
            <AppointmentActions appointment={appointment} isStaff={isStaff} customerZone={zone} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Contact</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {appointment.contact ? (
              <dl className="space-y-1">
                <div>
                  <dt className="text-fg-muted">Name</dt>
                  <dd>{appointment.contact.name ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Email</dt>
                  <dd>{appointment.contact.email ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Phone</dt>
                  <dd>{appointment.contact.phoneE164 ?? '—'}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-fg-muted">
                Contact details are shown to the booker and staff only.
              </p>
            )}
            <p className="mt-3 text-xs text-fg-muted">Version {appointment.version}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
