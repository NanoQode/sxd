import type { AppointmentDto, AppointmentSyncDto, BookingSettings } from '@simplexd/contracts';
import type { schema } from '@simplexd/db';
import { dualZoneLabel } from '@simplexd/integrations/google';
import type { AppointmentRow, Viewer } from './access';

export type EventSyncRow = typeof schema.eventSyncs.$inferSelect;

export const ACTIVE_STATUSES = new Set(['pending_confirmation', 'confirmed', 'rescheduled']);

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function icsPathFor(row: Pick<AppointmentRow, 'id' | 'icsToken'>): string {
  return `/api/v1/appointments/${row.id}/ics?token=${encodeURIComponent(row.icsToken)}`;
}

export function managePathFor(manageToken: string): string {
  return `/api/v1/appointments/manage/${encodeURIComponent(manageToken)}`;
}

export function calendarNoteFor(row: AppointmentRow, provider: 'google' | 'dev' | null): string {
  if (row.status === 'cancelled') {
    return row.calendarSyncStatus === 'cancelled' || row.calendarSyncStatus === 'not_requested'
      ? 'Cancelled; the calendar event was removed.'
      : 'Cancelled; removing the calendar event is still pending.';
  }
  const meetRequested = row.meetingProvider === 'google_meet';
  switch (row.calendarSyncStatus) {
    case 'not_requested':
      return 'No calendar sync requested; use the calendar download.';
    case 'pending':
      return meetRequested
        ? 'Calendar sync pending; the Google Meet link appears once Google confirms it. Use the calendar download meanwhile.'
        : 'Calendar sync pending; use the calendar download meanwhile.';
    case 'failed':
      return 'Calendar sync failed and will be retried; the calendar download still works. Staff can see the sanitised error.';
    case 'conflict':
      return 'The organiser changed or removed the event in Google Calendar; staff review is required before this time is trusted.';
    case 'synced':
      if (!meetRequested) return 'Synchronised with the organiser calendar.';
      if (row.conferenceStatus === 'ready')
        return provider === 'dev'
          ? 'Development adapter: the Meet link is simulated and does not open a real meeting.'
          : 'Google Meet link confirmed; join from a new tab.';
      if (row.conferenceStatus === 'pending')
        return 'Event created; Google is still preparing the Meet link.';
      if (row.conferenceStatus === 'failed')
        return 'Event created but Google could not create the Meet link; staff can retry it.';
      return 'Synchronised with the organiser calendar.';
    default:
      return '';
  }
}

export function toSyncDto(
  sync: EventSyncRow | null,
  provider: 'google' | 'dev' | null,
): AppointmentSyncDto | null {
  if (!sync) return null;
  return {
    status: sync.status,
    providerEventId: sync.providerEventId,
    providerCalendarId: sync.providerCalendarId,
    syncVersion: sync.syncVersion,
    attempts: sync.attempts,
    lastSyncedAt: sync.lastSyncedAt ? sync.lastSyncedAt.toISOString() : null,
    lastError: sync.lastErrorSanitized,
    provider,
  };
}

export interface ToDtoOptions {
  viewer: Viewer;
  staffName: string;
  settings: BookingSettings;
  sync?: EventSyncRow | null;
  provider?: 'google' | 'dev' | null;
  /** Include the manage path (creation response and manage-token endpoints only). */
  includeManagePath?: boolean;
  now?: Date;
}

export function toAppointmentDto(row: AppointmentRow, options: ToDtoOptions): AppointmentDto {
  const now = options.now ?? new Date();
  const staff = options.viewer.kind === 'staff';
  const active = isActiveStatus(row.status);
  const noticeOk =
    row.startsAt.getTime() - now.getTime() >= options.settings.minNoticeHours * 3600_000;
  const canChange = active && (staff || noticeOk);
  const provider = options.provider ?? null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    staff: { id: row.staffUserId, name: options.staffName },
    organizationId: row.organizationId,
    customerUserId: row.customerUserId,
    contact: {
      name: row.guestName,
      email: row.guestEmail,
      phoneE164: row.guestPhoneE164,
    },
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    businessTimeZone: row.businessTimeZone,
    customerTimeZone: row.customerTimeZone,
    label: dualZoneLabel(row.startsAt, row.businessTimeZone, row.customerTimeZone, row.endsAt),
    topic: row.topic,
    notes: row.notes,
    locationNote: row.locationNote,
    meetingProvider: row.meetingProvider,
    meetingUrl: row.conferenceStatus === 'ready' && active ? row.meetingUrl : null,
    conferenceStatus: row.conferenceStatus,
    calendarSyncStatus: row.calendarSyncStatus,
    calendarNote: calendarNoteFor(row, provider),
    cancellationReason: row.cancellationReason,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    icsPath: icsPathFor(row),
    managePath:
      options.includeManagePath && row.manageToken ? managePathFor(row.manageToken) : null,
    canReschedule: canChange,
    canCancel: canChange,
    cancellationPolicy: options.settings.cancellationPolicy,
    sync: staff ? toSyncDto(options.sync ?? null, provider) : null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
