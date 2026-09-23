import type { Metadata } from 'next';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataTable, EmptyState, PageHeader, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { listAppointments, type AppointmentListItem } from '@/server/portal/lists';

export const metadata: Metadata = { title: 'Appointments' };
export const dynamic = 'force-dynamic';

function columns(zone: string) {
  return [
    {
      key: 'when',
      header: 'When',
      cell: (a: AppointmentListItem) => (
        <div className="text-sm">
          <p>{formatDateTimeLabel(a.startsAt, zone)}</p>
          {zone !== a.businessTimeZone ? (
            <p className="text-xs text-fg-muted">{formatDateTimeLabel(a.startsAt, a.businessTimeZone)} business time</p>
          ) : null}
        </div>
      ),
    },
    { key: 'kind', header: 'Kind', cell: (a: AppointmentListItem) => humanize(a.kind) },
    { key: 'topic', header: 'Topic', cell: (a: AppointmentListItem) => a.topic ?? '—' },
    { key: 'status', header: 'Status', cell: (a: AppointmentListItem) => <StatusBadge status={a.status} /> },
    {
      key: 'meeting',
      header: 'Meeting',
      cell: (a: AppointmentListItem) =>
        a.meetingProvider === 'google_meet' ? (
          a.conferenceStatus === 'ready' && a.hasMeetingUrl ? (
            <Badge tone="success">Meet link ready</Badge>
          ) : (
            <Badge tone="warning">Meet link pending</Badge>
          )
        ) : (
          humanize(a.meetingProvider)
        ),
    },
    { key: 'staff', header: 'With', cell: (a: AppointmentListItem) => a.staffName ?? '—', hideOnMobile: true },
  ];
}

export default async function AppointmentsPage() {
  const identity = await requireSignedIn('/portal/appointments');
  const { upcoming, past } = await listAppointments(identity);
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  return (
    <div className="space-y-6">
      <PageHeader
        title="Appointments"
        description={`Consultations, viewings and site visits shown in your time zone (${zone}) and the business time zone (Africa/Lagos) where they differ.`}
      />
      <Card>
        <CardHeader>
          <CardTitle>Upcoming</CardTitle>
          <CardDescription>Meeting links appear only once the calendar provider confirms them; nothing is invented.</CardDescription>
        </CardHeader>
        <CardContent>
          {upcoming.length === 0 ? (
            <EmptyState
              title="No upcoming appointments"
              description="Booking with live availability, Google Calendar and Meet arrives in Wave 3. Until then the team schedules visits with you by message and they appear here."
            />
          ) : (
            <DataTable caption="Upcoming appointments" rows={upcoming} rowKey={(a) => a.id} rowLabel={(a) => `${humanize(a.kind)} ${formatDateTimeLabel(a.startsAt, zone)}`} columns={columns(zone)} />
          )}
        </CardContent>
      </Card>
      {past.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Past</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable caption="Past appointments" rows={past} rowKey={(a) => a.id} rowLabel={(a) => `${humanize(a.kind)} ${formatDateTimeLabel(a.startsAt, zone)}`} columns={columns(zone)} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
