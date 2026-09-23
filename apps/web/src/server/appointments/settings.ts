import { schema, type DbExecutor } from '@simplexd/db';
import {
  bookingSettingsSchema,
  GUEST_BOOKABLE_KINDS,
  type AppointmentKind,
  type BookingSettings,
} from '@simplexd/contracts';

/**
 * Booking configuration lives in `booking_settings` (key → JSON value, seeded
 * by `bookingDefaults` in packages/db). Missing keys fall back to the same
 * defaults so a partially configured console never breaks availability.
 */

const DEFAULTS: BookingSettings = {
  consultationDurationMinutes: 30,
  durationMinutesByKind: {
    consultation: 30,
    viewing: 60,
    site_visit: 120,
    virtual_inspection: 45,
    meeting: 30,
    test_booking: 15,
  },
  bufferMinutes: 10,
  holdTtlMinutes: 10,
  workingHours: { timeZone: 'Africa/Lagos', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
  holidays: [],
  cancellationPolicy:
    'Consultations can be rescheduled or cancelled up to 12 hours before the start time from the appointment link.',
  minNoticeHours: 12,
  maxDaysAhead: 60,
  routing: 'round_robin',
  autoConfirm: true,
  guestKinds: [...GUEST_BOOKABLE_KINDS],
  reminderHours: [24, 1],
};

/** Snake-case keys as stored in booking_settings. */
const KEY_MAP: Record<string, keyof BookingSettings> = {
  consultation_duration_minutes: 'consultationDurationMinutes',
  duration_minutes_by_kind: 'durationMinutesByKind',
  buffer_minutes: 'bufferMinutes',
  hold_ttl_minutes: 'holdTtlMinutes',
  working_hours: 'workingHours',
  holidays: 'holidays',
  cancellation_policy: 'cancellationPolicy',
  min_notice_hours: 'minNoticeHours',
  max_days_ahead: 'maxDaysAhead',
  routing: 'routing',
  auto_confirm: 'autoConfirm',
  guest_kinds: 'guestKinds',
  reminder_hours: 'reminderHours',
};

export async function loadBookingSettings(tx: DbExecutor): Promise<BookingSettings> {
  const rows = await tx
    .select({ key: schema.bookingSettings.key, value: schema.bookingSettings.value })
    .from(schema.bookingSettings);
  const merged: Record<string, unknown> = { ...DEFAULTS };
  for (const row of rows) {
    const field = KEY_MAP[row.key];
    if (!field || row.value === null || row.value === undefined) continue;
    merged[field] = row.value;
  }
  // Keep the per-kind map complete even when the admin only stored some kinds.
  merged['durationMinutesByKind'] = {
    ...DEFAULTS.durationMinutesByKind,
    ...((merged['durationMinutesByKind'] as Record<string, number> | undefined) ?? {}),
    consultation:
      (merged['consultationDurationMinutes'] as number | undefined) ??
      DEFAULTS.consultationDurationMinutes,
  };
  const parsed = bookingSettingsSchema.safeParse(merged);
  if (!parsed.success) {
    // A malformed admin value must not take bookings down; fall back and keep the rest.
    return { ...DEFAULTS, ...pickValid(merged) };
  }
  return parsed.data;
}

function pickValid(merged: Record<string, unknown>): Partial<BookingSettings> {
  const out: Partial<BookingSettings> = {};
  for (const [field, value] of Object.entries(merged)) {
    const key = field as keyof BookingSettings;
    const single = bookingSettingsSchema.shape[key];
    if (single && single.safeParse(value).success) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

export function durationForKind(settings: BookingSettings, kind: AppointmentKind): number {
  return settings.durationMinutesByKind[kind] ?? settings.consultationDurationMinutes;
}

export function meetingProviderForKind(
  kind: AppointmentKind,
): 'google_meet' | 'in_person' | 'none' {
  switch (kind) {
    case 'consultation':
    case 'virtual_inspection':
    case 'meeting':
    case 'test_booking':
      return 'google_meet';
    case 'viewing':
    case 'site_visit':
      return 'in_person';
    default:
      return 'none';
  }
}

export function isGuestBookable(settings: BookingSettings, kind: AppointmentKind): boolean {
  return settings.guestKinds.includes(kind);
}
