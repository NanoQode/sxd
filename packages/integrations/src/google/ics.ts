import { createEvent } from 'ics';
import type { DateArray, EventAttributes } from 'ics';
import { DateTime } from 'luxon';

/**
 * iCalendar download fallback. Used when Google is unavailable or the sync is
 * still pending: the customer can add the appointment to any calendar while
 * the provider sync stays visibly pending. A Meet link is included only when
 * one has actually been confirmed — never invented.
 */

export interface IcsEventInput {
  /** Stable per appointment (e.g. `${appointmentId}@simplexd`), reused on updates with a higher sequence. */
  uid: string;
  start: string | Date;
  end: string | Date;
  summary: string;
  description?: string;
  location?: string;
  organizerEmail: string;
  organizerName?: string;
  attendeeEmails: string[];
  /** Confirmed meeting URL, if any. */
  url?: string;
  /** Increment on reschedule/cancel so clients replace the earlier copy. */
  sequence?: number;
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
  method?: 'PUBLISH' | 'REQUEST' | 'CANCEL';
}

function toUtcArray(value: string | Date): DateArray {
  const dt =
    typeof value === 'string'
      ? DateTime.fromISO(value, { setZone: true })
      : DateTime.fromJSDate(value);
  if (!dt.isValid) throw new Error(`invalid date/time for ICS: ${String(value)}`);
  const u = dt.toUTC();
  return [u.year, u.month, u.day, u.hour, u.minute];
}

function singleLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

function assertEmail(email: string, label: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`${label} is not a valid email`);
}

export function buildIcs(input: IcsEventInput): string {
  assertEmail(input.organizerEmail, 'organizerEmail');
  for (const email of input.attendeeEmails) assertEmail(email, 'attendee email');
  if (input.url && !/^https?:\/\//i.test(input.url)) throw new Error('url must be http(s)');
  const start = toUtcArray(input.start);
  const end = toUtcArray(input.end);

  const attributes: EventAttributes = {
    uid: input.uid,
    productId: 'simplexd/appointments',
    method: input.method ?? 'PUBLISH',
    start,
    startInputType: 'utc',
    startOutputType: 'utc',
    end,
    endInputType: 'utc',
    endOutputType: 'utc',
    title: singleLine(input.summary),
    description: input.description,
    location: input.location ? singleLine(input.location) : undefined,
    url: input.url,
    status: input.status ?? 'CONFIRMED',
    busyStatus: input.status === 'CANCELLED' ? 'FREE' : 'BUSY',
    sequence: input.sequence ?? 0,
    organizer: { name: input.organizerName ?? 'SimplexD', email: input.organizerEmail },
    attendees: input.attendeeEmails.map((email) => ({
      email,
      rsvp: true,
      role: 'REQ-PARTICIPANT',
      partstat: 'NEEDS-ACTION',
    })),
  };

  const result = createEvent(attributes);
  if (result.error || !result.value) {
    throw new Error(`could not build ICS: ${result.error?.message ?? 'unknown error'}`);
  }
  return result.value;
}

export const ICS_CONTENT_TYPE = 'text/calendar; charset=utf-8';

/** Safe download file name for an ICS attachment. */
export function icsFileName(summary: string): string {
  const base = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'appointment'}.ics`;
}
