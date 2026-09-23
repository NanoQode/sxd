import type { Metadata } from 'next';
import { DateTime } from 'luxon';
import Link from 'next/link';
import { appointmentKindSchema, appointmentStatusSchema, type AppointmentListQuery } from '@simplexd/contracts';
import { Alert, Badge, DataTable, PageHeader, StatusBadge, buttonVariants, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { listAvailabilityWindows, staffAppointments } from '@/lib/admin/server/appointments';
import { calendarEntries } from '@/lib/admin/server/workload';
import { ApiAction } from '@/components/admin/api-action';
import { FilterBar, FilterCheckbox, FilterSelect } from '@/components/admin/filter-bar';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';
import { Section, TabLink, TabNav } from '@/components/admin/section';
import { WeekCalendar } from '../assignments/_components/week-calendar';
import { AppointmentActions } from './_components/appointment-actions';
import { TestBookingButton } from './_components/test-booking';

export const metadata: Metadata = { title: 'Appointments' };
export const dynamic = 'force-dynamic';

const ZONE = 'Africa/Lagos';
const WEEKDAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
type View = 'upcoming' | 'day' | 'past' | 'week';

export default async function AppointmentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const identity = await requireStaffPage('appointments.manage_all');
  const raw = await searchParams;
  const view: View = raw.view === 'day' || raw.view === 'past' || raw.view === 'week' ? raw.view : raw.date ? 'day' : 'upcoming';
  const day = raw.date && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? DateTime.fromISO(raw.date, { zone: ZONE }) : DateTime.now().setZone(ZONE);
  const now = DateTime.now();
  const status = appointmentStatusSchema.safeParse(raw.status).success ? (raw.status as AppointmentListQuery['status']) : undefined;
  const kind = appointmentKindSchema.safeParse(raw.kind).success ? (raw.kind as AppointmentListQuery['kind']) : undefined;
  const window =
    view === 'day'
      ? { from: day.startOf('day').toUTC().toISO()!, to: day.endOf('day').toUTC().toISO()! }
      : view === 'past'
        ? { to: now.toUTC().toISO()! }
        : { from: now.minus({ hours: 2 }).toUTC().toISO()!, to: now.plus({ days: 45 }).toUTC().toISO()! };
  const weekStart = day.startOf('week');
  const [data, windows, entries] = await Promise.all([
    staffAppointments(identity, {
      ...window,
      status,
      kind,
      staffUserId: raw.staff || undefined,
      scope: raw.mine === '1' ? 'mine' : 'all',
      cursor: view === 'past' ? raw.cursor || undefined : undefined,
      limit: 100,
    }),
    listAvailabilityWindows(identity),
    view === 'week'
      ? calendarEntries(identity, { from: weekStart.toUTC().toJSDate(), to: weekStart.plus({ days: 7 }).toUTC().toJSDate(), staffUserId: raw.staff || undefined })
      : Promise.resolve([]),
  ]);
  const items = view === 'past' ? data.items : [...data.items].reverse();
  const q = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...raw, cursor: undefined, ...patch })) if (v) params.set(k, v);
    return `/admin/appointments${params.size ? `?${params.toString()}` : ''}`;
  };
  const cal = data.calendar;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Appointments"
        description="Consultations, viewings, site visits and virtual inspections across staff. Times are shown in Africa/Lagos with the guest's zone alongside when it differs."
        actions={
          <Link href="/admin/appointments/book" className={buttonVariants({ size: 'md' })}>
            Book on behalf of a customer
          </Link>
        }
      />
      <TabNav label="Appointment views">
        <TabLink href={q({ view: undefined, date: undefined })} active={view === 'upcoming'}>
          Upcoming
        </TabLink>
        <TabLink href={q({ view: 'day', date: day.toISODate()! })} active={view === 'day'}>
          Day
        </TabLink>
        <TabLink href={q({ view: 'week', date: day.toISODate()! })} active={view === 'week'}>
          Week calendar
        </TabLink>
        <TabLink href={q({ view: 'past', date: undefined })} active={view === 'past'}>
          Past
        </TabLink>
      </TabNav>
      <SavedViewsBar tableKey="appointments" />
      <FilterBar hidden={{ view: raw.view }}>
        {view === 'day' || view === 'week' ? (
          <label className="text-sm">
            <span className="mb-1 block font-medium">Date</span>
            <input type="date" name="date" defaultValue={day.toISODate()!} className="h-11 w-full rounded-md border border-border-strong bg-bg-elevated px-3 text-sm" />
          </label>
        ) : null}
        <FilterSelect name="staff" label="Organiser" value={raw.staff} allLabel="All staff" options={data.staff.map((s) => ({ value: s.userId, label: s.name }))} />
        <FilterSelect name="status" label="Status" value={status} options={appointmentStatusSchema.options.map((s) => ({ value: s, label: humanize(s) }))} />
        <FilterSelect name="kind" label="Kind" value={kind} options={appointmentKindSchema.options.map((s) => ({ value: s, label: humanize(s) }))} />
        <FilterCheckbox name="mine" label="Only mine" checked={raw.mine === '1'} />
      </FilterBar>

      {view === 'week' ? (
        <Section
          title={`Week of ${weekStart.toFormat('d LLL yyyy')}`}
          description="Appointments and scheduled site visits."
          actions={
            <>
              <Link href={q({ view: 'week', date: weekStart.minus({ days: 7 }).toISODate()! })} className="text-sm underline">
                Previous week
              </Link>
              <Link href={q({ view: 'week', date: weekStart.plus({ days: 7 }).toISODate()! })} className="text-sm underline">
                Next week
              </Link>
            </>
          }
        >
          <WeekCalendar weekStartIso={weekStart.toUTC().toISO()!} entries={entries} />
        </Section>
      ) : (
        <Section
          title={view === 'day' ? day.toFormat('cccc d LLLL yyyy') : view === 'past' ? 'Past appointments' : 'Next 45 days'}
          actions={
            view === 'day' ? (
              <>
                <Link href={q({ view: 'day', date: day.minus({ days: 1 }).toISODate()! })} className="text-sm underline">
                  Previous day
                </Link>
                <Link href={q({ view: 'day', date: day.plus({ days: 1 }).toISODate()! })} className="text-sm underline">
                  Next day
                </Link>
              </>
            ) : undefined
          }
        >
          <DataTable
            caption="Appointments"
            rows={items}
            rowKey={(a) => a.id}
            rowLabel={(a) => `${humanize(a.kind)} ${a.contact?.name ?? ''}`}
            emptyMessage="No appointments in this view."
            columns={[
              {
                key: 'when',
                header: 'When',
                cell: (a) => (
                  <span id={`appt-${a.id}`}>
                    <span className="font-medium">{a.label.business}</span>
                    {!a.label.sameZone ? <span className="block text-xs text-fg-muted">Guest: {a.label.customer}</span> : null}
                  </span>
                ),
              },
              { key: 'kind', header: 'Kind', cell: (a) => <span>{humanize(a.kind)}{a.topic ? <span className="block text-xs text-fg-muted">{a.topic}</span> : null}</span> },
              { key: 'who', header: 'Guest', cell: (a) => (a.contact ? <span>{a.contact.name ?? '—'}<span className="block text-xs text-fg-muted">{a.contact.email ?? ''}{a.contact.phoneE164 ? ` · ${a.contact.phoneE164}` : ''}</span></span> : '—') },
              { key: 'staff', header: 'Organiser', cell: (a) => a.staff.name, hideOnMobile: true },
              { key: 'status', header: 'Status', cell: (a) => <StatusBadge status={a.status === 'pending_confirmation' ? 'pending' : a.status === 'confirmed' ? 'accepted' : a.status} label={humanize(a.status)} /> },
              {
                key: 'sync',
                header: 'Calendar / Meet',
                cell: (a) => (
                  <span className="text-xs">
                    <Badge tone={a.calendarSyncStatus === 'synced' ? 'success' : ['failed', 'conflict'].includes(a.calendarSyncStatus) ? 'danger' : 'neutral'}>{humanize(a.calendarSyncStatus)}</Badge>
                    {a.meetingUrl ? (
                      <a href={a.meetingUrl} target="_blank" rel="noreferrer" className="ml-1 underline">
                        Meet
                      </a>
                    ) : null}
                    <span className="block text-fg-muted">{a.calendarNote}</span>
                  </span>
                ),
                hideOnMobile: true,
              },
              { key: 'act', header: 'Actions', cell: (a) => <AppointmentActions appointment={a} staff={data.staff} /> },
            ]}
          />
          {view === 'past' && data.nextCursor ? (
            <Link href={`${q({ view: 'past' })}&cursor=${encodeURIComponent(data.nextCursor)}`} className="text-sm underline">
              Older
            </Link>
          ) : null}
        </Section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="Google Calendar and Meet"
          description="Real provider state: a saved OAuth client is not the same as a connected organiser."
          actions={
            data.permissions.integrations ? (
              <Link href="/admin/integrations/google_workspace" className="text-sm underline">
                Integration settings
              </Link>
            ) : undefined
          }
        >
          {!cal ? (
            <Alert tone="warning" title="Calendar status unavailable">
              The calendar status could not be read for your role.
            </Alert>
          ) : (
            <>
              <Alert tone={cal.adapter === 'google' && cal.connections.some((c) => c.status === 'connected') ? 'success' : cal.adapter === 'dev' ? 'info' : 'warning'} title={cal.adapter ? `${cal.adapter === 'google' ? 'Google' : 'Development'} adapter · ${cal.environment}` : 'No calendar adapter configured'}>
                {cal.message}
              </Alert>
              <p className="text-xs text-fg-muted">
                Sync queue: {cal.syncSummary.pending} pending, {cal.syncSummary.failed} failed, {cal.syncSummary.conflict} conflicts · Meet: {cal.syncSummary.conferencePending} pending, {cal.syncSummary.conferenceFailed} failed.
              </p>
              {cal.connections.length === 0 ? (
                <p className="text-fg-muted">No organiser has connected a Google calendar.</p>
              ) : (
                <ul className="space-y-2">
                  {cal.connections.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2">
                      <span>
                        {c.organizer.name} <span className="text-xs text-fg-muted">{c.accountEmail ?? c.organizer.email}</span>
                        {c.lastError ? <span className="block text-xs text-danger">{c.lastError}</span> : null}
                        {c.remedy ? <span className="block text-xs text-fg-muted">{c.remedy}</span> : null}
                        {c.missingScopes.length > 0 ? <span className="block text-xs text-warning">Missing scopes: {c.missingScopes.join(', ')}</span> : null}
                      </span>
                      <span className="flex items-center gap-2">
                        <StatusBadge status={c.status} />
                        <ApiAction path={`/api/v1/admin/calendar/connections/${c.id}/check`} label="Check now" successMessage="Connection checked" />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {cal.adapter ? (
                <a href="/api/v1/calendar/connect?redirect=1" className="text-sm underline">
                  Connect my calendar as an organiser
                </a>
              ) : null}
            </>
          )}
          {data.permissions.testBooking ? <TestBookingButton /> : null}
        </Section>

        <Section title="Staff availability" description="Weekly windows used to generate bookable slots.">
          <Alert tone="info" title="Read-only">
            There is no availability write endpoint yet; windows are managed in the database seed. Booking rules (durations, buffers, notice) live in{' '}
            <Link href="/admin/settings" className="underline">
              Settings
            </Link>
            .
          </Alert>
          {windows.length === 0 ? (
            <p className="text-fg-muted">No availability configured, so no slots can be offered.</p>
          ) : (
            <DataTable
              caption="Availability windows"
              rows={windows}
              rowKey={(w) => w.id}
              rowLabel={(w) => `${w.staffName} ${WEEKDAYS[w.weekday] ?? w.weekday}`}
              columns={[
                { key: 'who', header: 'Staff', cell: (w) => w.staffName },
                { key: 'day', header: 'Day', cell: (w) => WEEKDAYS[w.weekday] ?? String(w.weekday) },
                { key: 'time', header: 'Hours', cell: (w) => `${w.startTime.slice(0, 5)}–${w.endTime.slice(0, 5)} ${w.timeZone}` },
                { key: 'kinds', header: 'Kinds', cell: (w) => (w.kinds.length ? w.kinds.map(humanize).join(', ') : 'all'), hideOnMobile: true },
                { key: 'on', header: 'Active', cell: (w) => (w.active ? 'yes' : 'no') },
              ]}
            />
          )}
        </Section>
      </div>
      <p className="text-xs text-fg-muted">Updated {formatDateTimeLabel(new Date().toISOString())}.</p>
    </div>
  );
}
