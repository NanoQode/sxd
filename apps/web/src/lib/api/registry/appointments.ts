import { z } from 'zod';
import {
  appointmentDtoSchema,
  appointmentListQuerySchema,
  appointmentPageSchema,
  availabilityQuerySchema,
  availabilityReplaceSchema,
  availabilityResponseSchema,
  bookingCreateSchema,
  calendarConnectionDtoSchema,
  calendarStatusDtoSchema,
  cancelSchema,
  connectStartResponseSchema,
  holdCreateSchema,
  holdDtoSchema,
  listRoutes,
  registerRoute,
  rescheduleSchema,
  staffAvailabilityDtoSchema,
  testBookingResultSchema,
  timeOffCreateSchema,
  uuidSchema,
  type RouteSpec,
} from '@simplexd/contracts';

/**
 * OpenAPI registration for appointments, booking holds and the Google
 * Calendar/Meet connection. Registration is idempotent (hot reloads).
 */
function ensure(spec: RouteSpec): RouteSpec {
  const existing = listRoutes().find((r) => r.operationId === spec.operationId);
  return existing ?? registerRoute(spec);
}

const idParams = z.object({ id: uuidSchema });
const tokenParams = z.object({ token: z.string() });

export const availabilityRoute = ensure({
  method: 'get',
  path: '/api/v1/appointments/availability',
  summary: 'Available appointment slots',
  description:
    'Staff working windows minus unexpired holds, appointments, leave and (when an organiser is connected) Google busy periods, with the booking buffer. Slots are UTC instants with DST-aware business and customer labels. Anonymous callers only see guest-bookable kinds; rate limited per hashed IP.',
  tags: ['appointments'],
  operationId: 'appointments.availability',
  auth: 'public',
  request: { query: availabilityQuerySchema },
  responses: {
    200: { description: 'Slots', body: availabilityResponseSchema },
    429: { description: 'Rate limited' },
  },
});

export const holdRoute = ensure({
  method: 'post',
  path: '/api/v1/appointments/holds',
  summary: 'Hold a slot for a few minutes',
  description:
    'Inserts an expiring reservation; the database exclusion constraint makes concurrent holds on overlapping slots fail with slot_unavailable so exactly one requester wins.',
  tags: ['appointments'],
  operationId: 'appointments.holds.create',
  auth: 'public',
  request: { body: holdCreateSchema },
  responses: {
    201: { description: 'Hold', body: holdDtoSchema },
    401: { description: 'Kind requires an account' },
    409: { description: 'Slot unavailable' },
    429: { description: 'Rate limited' },
  },
});

export const bookRoute = ensure({
  method: 'post',
  path: '/api/v1/appointments',
  summary: 'Book an appointment from a hold',
  description:
    'Converts a live hold into an appointment, stores the customer or guest details, queues the calendar/Meet sync and the confirmation notification. Guests may only book guest-bookable kinds and must give email and phone. Idempotent via Idempotency-Key.',
  tags: ['appointments'],
  operationId: 'appointments.create',
  auth: 'public',
  idempotent: true,
  request: { body: bookingCreateSchema },
  responses: {
    201: { description: 'Appointment (includes the manage link)', body: appointmentDtoSchema },
    409: { description: 'Hold expired or already used' },
  },
});

export const listRoute = ensure({
  method: 'get',
  path: '/api/v1/appointments',
  summary: 'List appointments',
  description:
    "Staff with appointments.manage_all see everything (filter by staffUserId or scope=mine); other staff, partners and inspectors see appointments they organise; customers see their own and, with org.appointments.manage, their organisation's.",
  tags: ['appointments'],
  operationId: 'appointments.list',
  auth: 'session',
  request: { query: appointmentListQuerySchema },
  responses: { 200: { description: 'Page', body: appointmentPageSchema } },
});

export const detailRoute = ensure({
  method: 'get',
  path: '/api/v1/appointments/{id}',
  summary: 'Appointment detail',
  tags: ['appointments'],
  operationId: 'appointments.get',
  auth: 'session',
  request: { params: idParams },
  responses: {
    200: { description: 'Appointment', body: appointmentDtoSchema },
    404: { description: 'Not found' },
  },
});

export const rescheduleRoute = ensure({
  method: 'post',
  path: '/api/v1/appointments/{id}/reschedule',
  summary: 'Reschedule onto a fresh hold',
  description:
    'Atomically releases the old reservation and promotes the new hold, bumps the version, updates the linked calendar event (etag-checked) and resets reminders. Customers must respect the minimum notice; staff may override.',
  tags: ['appointments'],
  operationId: 'appointments.reschedule',
  auth: 'session',
  idempotent: true,
  request: { params: idParams, body: rescheduleSchema },
  responses: {
    200: { description: 'Appointment', body: appointmentDtoSchema },
    409: { description: 'Hold invalid or notice too short' },
  },
});

export const cancelRoute = ensure({
  method: 'post',
  path: '/api/v1/appointments/{id}/cancel',
  summary: 'Cancel with a reason',
  tags: ['appointments'],
  operationId: 'appointments.cancel',
  auth: 'session',
  request: { params: idParams, body: cancelSchema },
  responses: {
    200: { description: 'Appointment', body: appointmentDtoSchema },
    409: { description: 'Invalid transition' },
  },
});

export const confirmRoute = ensure({
  method: 'post',
  path: '/api/v1/appointments/{id}/confirm',
  summary: 'Staff confirm a pending booking',
  tags: ['appointments', 'staff'],
  operationId: 'appointments.confirm',
  auth: 'staff',
  request: { params: idParams },
  responses: { 200: { description: 'Appointment', body: appointmentDtoSchema } },
});

export const retrySyncRoute = ensure({
  method: 'post',
  path: '/api/v1/appointments/{id}/retry-sync',
  summary: 'Retry calendar sync / Meet creation',
  description:
    'Re-runs a failed calendar sync or, after a failed Meet conference, asks Google for a new one with a fresh request id. The worker records the real outcome; no link is invented.',
  tags: ['appointments', 'staff'],
  operationId: 'appointments.retrySync',
  auth: 'staff',
  request: { params: idParams },
  responses: { 200: { description: 'Appointment', body: appointmentDtoSchema } },
});

export const icsRoute = ensure({
  method: 'get',
  path: '/api/v1/appointments/{id}/ics',
  summary: 'Calendar file download',
  description:
    'text/calendar fallback that works while Google sync is pending; includes the Meet link only once confirmed.',
  tags: ['appointments'],
  operationId: 'appointments.ics',
  auth: 'public',
  request: { params: idParams, query: z.object({ token: z.string() }) },
  responses: { 200: { description: 'ICS file' }, 404: { description: 'Not found' } },
});

export const manageGetRoute = ensure({
  method: 'get',
  path: '/api/v1/appointments/manage/{token}',
  summary: 'Guest appointment view (manage link)',
  tags: ['appointments'],
  operationId: 'appointments.manage.get',
  auth: 'public',
  request: { params: tokenParams },
  responses: { 200: { description: 'Appointment', body: appointmentDtoSchema } },
});

export const manageRescheduleRoute = ensure({
  method: 'post',
  path: '/api/v1/appointments/manage/{token}/reschedule',
  summary: 'Guest reschedule',
  tags: ['appointments'],
  operationId: 'appointments.manage.reschedule',
  auth: 'public',
  request: { params: tokenParams, body: rescheduleSchema },
  responses: { 200: { description: 'Appointment', body: appointmentDtoSchema } },
});

export const manageCancelRoute = ensure({
  method: 'post',
  path: '/api/v1/appointments/manage/{token}/cancel',
  summary: 'Guest cancel',
  tags: ['appointments'],
  operationId: 'appointments.manage.cancel',
  auth: 'public',
  request: { params: tokenParams, body: cancelSchema },
  responses: { 200: { description: 'Appointment', body: appointmentDtoSchema } },
});

export const calendarConnectRoute = ensure({
  method: 'get',
  path: '/api/v1/calendar/connect',
  summary: 'Start the organiser Google grant',
  description:
    'Server-side authorisation code flow with PKCE and HMAC-signed state; requires appointments.manage_all.',
  tags: ['calendar', 'staff'],
  operationId: 'calendar.connect',
  auth: 'staff',
  request: {
    query: z.object({ calendarId: z.string().optional(), redirect: z.enum(['0', '1']).optional() }),
  },
  responses: {
    200: { description: 'Authorization URL', body: connectStartResponseSchema },
    302: { description: 'Redirect to Google' },
  },
});

export const calendarCallbackRoute = ensure({
  method: 'get',
  path: '/api/v1/calendar/callback',
  summary: 'OAuth callback',
  description:
    'Verifies state and PKCE, exchanges the code, stores encrypted tokens and redirects to the admin page.',
  tags: ['calendar', 'staff'],
  operationId: 'calendar.callback',
  auth: 'staff',
  request: {
    query: z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  responses: { 302: { description: 'Redirect to the admin page with the outcome' } },
});

export const calendarDisconnectRoute = ensure({
  method: 'post',
  path: '/api/v1/calendar/disconnect',
  summary: 'Disconnect an organiser',
  tags: ['calendar', 'staff'],
  operationId: 'calendar.disconnect',
  auth: 'staff',
  request: { body: z.object({ connectionId: uuidSchema }) },
  responses: { 200: { description: 'Connection', body: calendarConnectionDtoSchema } },
});

export const calendarPushRoute = ensure({
  method: 'post',
  path: '/api/v1/calendar/push',
  summary: 'Google Calendar push receiver',
  description:
    'Header-only notification; the channel token is checked against the stored hash and an authenticated incremental sync is queued.',
  tags: ['calendar', 'webhooks'],
  operationId: 'calendar.push',
  auth: 'webhook',
  responses: {
    200: { description: 'Accepted' },
    403: { description: 'Token mismatch' },
    404: { description: 'Unknown channel' },
  },
});

export const calendarStatusRoute = ensure({
  method: 'get',
  path: '/api/v1/admin/calendar/status',
  summary: 'Calendar integration status',
  description:
    'Adapter, redirect URI, organiser grants (connected / degraded / expired / disconnected with remedies) and sync health counts.',
  tags: ['calendar', 'admin'],
  operationId: 'admin.calendar.status',
  auth: 'staff',
  responses: { 200: { description: 'Status', body: calendarStatusDtoSchema } },
});

export const calendarCheckRoute = ensure({
  method: 'post',
  path: '/api/v1/admin/calendar/connections/{id}/check',
  summary: 'Check an organiser grant now',
  tags: ['calendar', 'admin'],
  operationId: 'admin.calendar.check',
  auth: 'staff',
  request: { params: idParams },
  responses: { 200: { description: 'Connection', body: calendarConnectionDtoSchema } },
});

export const calendarTestBookingRoute = ensure({
  method: 'post',
  path: '/api/v1/admin/calendar/test-booking',
  summary: 'Test booking through the provider',
  description:
    'Creates a 15-minute event with a Meet request, reads it back and deletes it; reports the real provider result. Requires appointments.test_booking.',
  tags: ['calendar', 'admin'],
  operationId: 'admin.calendar.testBooking',
  auth: 'staff',
  responses: { 200: { description: 'Result', body: testBookingResultSchema } },
});

const staffParams = z.object({ staffUserId: z.string() });

export const staffAvailabilityGetRoute = ensure({
  method: 'get',
  path: '/api/v1/appointments/staff/{staffUserId}',
  summary: 'Working windows and upcoming time off',
  description:
    'The person themselves (staff, or a partner with partner.availability.manage) or staff with appointments.manage_all.',
  tags: ['appointments'],
  operationId: 'appointments.staffAvailability.get',
  auth: 'session',
  request: { params: staffParams },
  responses: { 200: { description: 'Availability', body: staffAvailabilityDtoSchema } },
});

export const staffAvailabilityPutRoute = ensure({
  method: 'put',
  path: '/api/v1/appointments/staff/{staffUserId}',
  summary: 'Replace weekly working windows',
  description:
    'ISO weekdays (1 = Monday) with local start/end times and a time zone; optional appointment kinds per window. Audited.',
  tags: ['appointments'],
  operationId: 'appointments.staffAvailability.replace',
  auth: 'session',
  request: { params: staffParams, body: availabilityReplaceSchema },
  responses: { 200: { description: 'Availability', body: staffAvailabilityDtoSchema } },
});

export const timeOffCreateRoute = ensure({
  method: 'post',
  path: '/api/v1/appointments/staff/{staffUserId}/time-off',
  summary: 'Block a period (leave or block)',
  description:
    'Refused with slot_unavailable when the period overlaps an appointment, hold or other time off (database exclusion constraint).',
  tags: ['appointments'],
  operationId: 'appointments.timeOff.create',
  auth: 'session',
  request: { params: staffParams, body: timeOffCreateSchema },
  responses: {
    201: { description: 'Availability', body: staffAvailabilityDtoSchema },
    409: { description: 'Overlaps a booking' },
  },
});

export const timeOffDeleteRoute = ensure({
  method: 'delete',
  path: '/api/v1/appointments/staff/{staffUserId}/time-off/{reservationId}',
  summary: 'Remove a time-off entry',
  tags: ['appointments'],
  operationId: 'appointments.timeOff.delete',
  auth: 'session',
  request: { params: z.object({ staffUserId: z.string(), reservationId: uuidSchema }) },
  responses: { 200: { description: 'Availability', body: staffAvailabilityDtoSchema } },
});
