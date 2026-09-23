import { z } from 'zod';
import {
  cursorPaginationQuerySchema,
  emailSchema,
  isoDateTimeSchema,
  phoneE164Schema,
  timeZoneSchema,
  uuidSchema,
} from './common';

/**
 * Appointments, booking holds and Google Calendar/Meet synchronisation.
 * Times travel as RFC 3339 UTC instants; every slot and appointment also
 * carries DST-aware wall-clock labels in the business and customer zones.
 */

export const appointmentKindSchema = z.enum([
  'consultation',
  'viewing',
  'site_visit',
  'virtual_inspection',
  'meeting',
  'test_booking',
]);
export type AppointmentKind = z.infer<typeof appointmentKindSchema>;

export const appointmentStatusSchema = z.enum([
  'pending_confirmation',
  'confirmed',
  'rescheduled',
  'cancelled',
  'completed',
  'no_show',
]);
export type AppointmentStatus = z.infer<typeof appointmentStatusSchema>;

export const calendarSyncStatusSchema = z.enum([
  'not_requested',
  'pending',
  'synced',
  'failed',
  'cancelled',
  'conflict',
]);
export const conferenceStatusSchema = z.enum(['none', 'pending', 'ready', 'failed']);
export const meetingProviderSchema = z.enum(['none', 'google_meet', 'external', 'in_person']);

export const dualZoneLabelSchema = z.object({
  business: z.string(),
  customer: z.string(),
  sameZone: z.boolean(),
  dateDiffers: z.boolean(),
  businessOffsetMinutes: z.number().int(),
  customerOffsetMinutes: z.number().int(),
});
export type DualZoneLabelDto = z.infer<typeof dualZoneLabelSchema>;

/** Kinds a visitor may book without an account (guest booking). */
export const GUEST_BOOKABLE_KINDS: readonly AppointmentKind[] = ['consultation'];

export const availabilityQuerySchema = z
  .object({
    kind: appointmentKindSchema.default('consultation'),
    staffUserId: z.string().min(1).max(64).optional(),
    from: isoDateTimeSchema,
    to: isoDateTimeSchema,
    /** Customer IANA zone used for the second label. */
    tz: timeZoneSchema.default('Africa/Lagos'),
  })
  .refine((q) => new Date(q.to).getTime() > new Date(q.from).getTime(), {
    message: 'to must be after from',
    path: ['to'],
  })
  .refine((q) => new Date(q.to).getTime() - new Date(q.from).getTime() <= 32 * 24 * 3600_000, {
    message: 'availability windows are limited to 32 days',
    path: ['to'],
  });
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export const availabilitySlotSchema = z.object({
  start: isoDateTimeSchema,
  end: isoDateTimeSchema,
  staffUserId: z.string(),
  label: dualZoneLabelSchema,
});
export type AvailabilitySlotDto = z.infer<typeof availabilitySlotSchema>;

export const availabilityResponseSchema = z.object({
  kind: appointmentKindSchema,
  durationMinutes: z.number().int().positive(),
  bufferMinutes: z.number().int().nonnegative(),
  minNoticeHours: z.number().int().nonnegative(),
  maxDaysAhead: z.number().int().positive(),
  businessTimeZone: z.string(),
  customerTimeZone: z.string(),
  /** True when the organiser's external calendar busy times were combined. */
  providerBusyIncluded: z.boolean(),
  /** Set when no staff availability is configured for the kind; slots are then empty. */
  unavailableReason: z.enum(['no_staff_configured', 'kind_not_bookable']).nullable(),
  slots: z.array(availabilitySlotSchema),
  generatedAt: isoDateTimeSchema,
});
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;

export const holdCreateSchema = z.object({
  kind: appointmentKindSchema.default('consultation'),
  staffUserId: z.string().min(1).max(64).optional(),
  start: isoDateTimeSchema,
  customerTimeZone: timeZoneSchema.default('Africa/Lagos'),
});
export type HoldCreate = z.infer<typeof holdCreateSchema>;

export const holdDtoSchema = z.object({
  holdToken: z.string(),
  kind: appointmentKindSchema,
  staffUserId: z.string(),
  start: isoDateTimeSchema,
  end: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  label: dualZoneLabelSchema,
});
export type HoldDto = z.infer<typeof holdDtoSchema>;

export const guestDetailsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: emailSchema,
  phoneE164: phoneE164Schema,
});

export const bookingCreateSchema = z.object({
  holdToken: z.string().min(16).max(128),
  /** Optional cross-check against the kind the hold was taken for. */
  kind: appointmentKindSchema.optional(),
  /** Required for anonymous (guest) bookings; ignored for signed-in customers. */
  guest: guestDetailsSchema.optional(),
  customerTimeZone: timeZoneSchema.default('Africa/Lagos'),
  topic: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(4000).optional(),
  leadId: uuidSchema.optional(),
  serviceRequestId: uuidSchema.optional(),
});
export type BookingCreate = z.infer<typeof bookingCreateSchema>;

export const rescheduleSchema = z.object({
  holdToken: z.string().min(16).max(128),
  reason: z.string().trim().max(500).optional(),
});
export type RescheduleInput = z.infer<typeof rescheduleSchema>;

export const cancelSchema = z.object({
  reason: z.string().trim().min(2).max(500),
});
export type CancelInput = z.infer<typeof cancelSchema>;

export const appointmentSyncDtoSchema = z.object({
  status: z.enum(['pending', 'created', 'updated', 'cancelled', 'failed', 'conflict']),
  providerEventId: z.string().nullable(),
  providerCalendarId: z.string().nullable(),
  syncVersion: z.number().int(),
  attempts: z.number().int(),
  lastSyncedAt: isoDateTimeSchema.nullable(),
  lastError: z.string().nullable(),
  provider: z.enum(['google', 'dev']).nullable(),
});
export type AppointmentSyncDto = z.infer<typeof appointmentSyncDtoSchema>;

export const appointmentDtoSchema = z.object({
  id: uuidSchema,
  kind: appointmentKindSchema,
  status: appointmentStatusSchema,
  staff: z.object({ id: z.string(), name: z.string() }),
  organizationId: z.string().nullable(),
  customerUserId: z.string().nullable(),
  /** Only present for staff and the customer themselves. */
  contact: z
    .object({ name: z.string().nullable(), email: z.string().nullable(), phoneE164: z.string().nullable() })
    .nullable(),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  businessTimeZone: z.string(),
  customerTimeZone: z.string(),
  label: dualZoneLabelSchema,
  topic: z.string().nullable(),
  notes: z.string().nullable(),
  locationNote: z.string().nullable(),
  meetingProvider: meetingProviderSchema,
  /** Private: present only when the conference is ready and the caller is a participant or staff. */
  meetingUrl: z.string().nullable(),
  conferenceStatus: conferenceStatusSchema,
  calendarSyncStatus: calendarSyncStatusSchema,
  /** Human explanation of the calendar/Meet state (never invents a link). */
  calendarNote: z.string(),
  cancellationReason: z.string().nullable(),
  cancelledAt: isoDateTimeSchema.nullable(),
  icsPath: z.string(),
  /** Only returned to the booker on creation and through the manage-token endpoints. */
  managePath: z.string().nullable(),
  canReschedule: z.boolean(),
  canCancel: z.boolean(),
  cancellationPolicy: z.string(),
  /** Staff only. */
  sync: appointmentSyncDtoSchema.nullable(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type AppointmentDto = z.infer<typeof appointmentDtoSchema>;

export const appointmentListQuerySchema = cursorPaginationQuerySchema.extend({
  status: appointmentStatusSchema.optional(),
  kind: appointmentKindSchema.optional(),
  staffUserId: z.string().max(64).optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  /** `mine` limits staff to appointments where they are the organiser. */
  scope: z.enum(['all', 'mine']).default('all'),
});
export type AppointmentListQuery = z.infer<typeof appointmentListQuerySchema>;

export const appointmentPageSchema = z.object({
  items: z.array(appointmentDtoSchema),
  nextCursor: z.string().nullable(),
});

export const bookingSettingsSchema = z.object({
  consultationDurationMinutes: z.number().int().positive(),
  durationMinutesByKind: z.record(appointmentKindSchema, z.number().int().positive()),
  bufferMinutes: z.number().int().nonnegative(),
  holdTtlMinutes: z.number().int().positive(),
  workingHours: z.object({
    timeZone: timeZoneSchema,
    days: z.array(z.number().int().min(1).max(7)),
    start: z.string(),
    end: z.string(),
  }),
  holidays: z.array(z.string()),
  cancellationPolicy: z.string(),
  minNoticeHours: z.number().int().nonnegative(),
  maxDaysAhead: z.number().int().positive(),
  routing: z.enum(['round_robin', 'first_available']),
  autoConfirm: z.boolean(),
  guestKinds: z.array(appointmentKindSchema),
  reminderHours: z.array(z.number().int().positive()),
});
export type BookingSettings = z.infer<typeof bookingSettingsSchema>;

/* ---------- Calendar connection administration ---------- */

export const calendarConnectionStatusSchema = z.enum([
  'disconnected',
  'configured_unverified',
  'connected',
  'degraded',
  'expired',
  'disabled',
]);

export const calendarConnectionDtoSchema = z.object({
  id: uuidSchema,
  provider: z.string(),
  environment: z.string(),
  organizer: z.object({ userId: z.string(), name: z.string(), email: z.string() }),
  accountEmail: z.string().nullable(),
  calendarId: z.string().nullable(),
  scopes: z.array(z.string()),
  missingScopes: z.array(z.string()),
  status: calendarConnectionStatusSchema,
  accessTokenExpiresAt: isoDateTimeSchema.nullable(),
  lastCheckedAt: isoDateTimeSchema.nullable(),
  lastCheckOk: z.boolean().nullable(),
  lastError: z.string().nullable(),
  /** Reconnect instructions when the grant expired. */
  remedy: z.string().nullable(),
  connectedAt: isoDateTimeSchema.nullable(),
  disconnectedAt: isoDateTimeSchema.nullable(),
  watch: z
    .object({
      channelId: z.string(),
      expiration: isoDateTimeSchema.nullable(),
      status: z.string(),
      lastNotificationAt: isoDateTimeSchema.nullable(),
    })
    .nullable(),
});
export type CalendarConnectionDto = z.infer<typeof calendarConnectionDtoSchema>;

export const calendarStatusDtoSchema = z.object({
  /** `google` when a client id/secret is active, `dev` for the labelled development adapter, null when neither is usable. */
  adapter: z.enum(['google', 'dev']).nullable(),
  /** OAuth client credentials saved in Admin → Integrations (not the same as a connected organiser). */
  clientConfigured: z.boolean(),
  environment: z.enum(['test', 'live']),
  /** Exact redirect URI to register in the Google Cloud console. */
  redirectUri: z.string(),
  pushAddress: z.string().nullable(),
  connections: z.array(calendarConnectionDtoSchema),
  syncSummary: z.object({
    pending: z.number().int(),
    failed: z.number().int(),
    conflict: z.number().int(),
    conferencePending: z.number().int(),
    conferenceFailed: z.number().int(),
  }),
  message: z.string(),
});
export type CalendarStatusDto = z.infer<typeof calendarStatusDtoSchema>;

export const testBookingResultSchema = z.object({
  ok: z.boolean(),
  adapter: z.enum(['google', 'dev']),
  connectionId: uuidSchema.nullable(),
  eventId: z.string().nullable(),
  htmlLink: z.string().nullable(),
  conferenceStatus: conferenceStatusSchema,
  meetUrl: z.string().nullable(),
  deleted: z.boolean(),
  message: z.string(),
  checkedAt: isoDateTimeSchema,
});
export type TestBookingResult = z.infer<typeof testBookingResultSchema>;

export const connectStartResponseSchema = z.object({
  authorizationUrl: z.string(),
  adapter: z.enum(['google', 'dev']),
});
