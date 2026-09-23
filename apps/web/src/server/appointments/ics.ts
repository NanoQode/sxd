import { and, eq } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { getDb, schema, systemContext, withActor } from '@simplexd/db';
import { buildIcs, icsFileName } from '@simplexd/integrations/google';
import { isActiveStatus } from './dto';

/**
 * Calendar download fallback. Works whether or not Google sync succeeded; the
 * Meet URL is included only once the provider confirmed it. The ICS token is
 * unguessable and separate from the manage token so a shared calendar file
 * never grants reschedule/cancel rights.
 */
export interface IcsDownload {
  fileName: string;
  body: string;
}

export async function buildAppointmentIcs(id: string, icsToken: string): Promise<IcsDownload> {
  return withActor(getDb(), systemContext('appointments-ics'), async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.appointments)
      .where(and(eq(schema.appointments.id, id), eq(schema.appointments.icsToken, icsToken)));
    if (!row) throw new ApiError('not_found', 'appointment not found');
    const [staff] = await tx
      .select({ name: schema.user.name, email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, row.staffUserId));
    const organizerEmail =
      staff?.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(staff.email)
        ? staff.email
        : 'no-reply@simplexd.local';
    const active = isActiveStatus(row.status);
    const summary = `SimplexD ${row.kind.replace(/_/g, ' ')}${row.topic ? `: ${row.topic}` : ''}`;
    const descriptionParts = [
      `Business time: ${row.businessTimeZone}. Your time zone: ${row.customerTimeZone}.`,
      row.meetingProvider === 'google_meet'
        ? row.conferenceStatus === 'ready' && row.meetingUrl
          ? `Join: ${row.meetingUrl}`
          : 'The Google Meet link will be sent once confirmed; this file does not contain one yet.'
        : row.locationNote
          ? `Location: ${row.locationNote}`
          : '',
      row.status === 'cancelled' ? `Cancelled: ${row.cancellationReason ?? ''}` : '',
    ].filter(Boolean);
    const body = buildIcs({
      uid: `${row.id}@simplexd`,
      start: row.startsAt,
      end: row.endsAt,
      summary,
      description: descriptionParts.join('\n'),
      location: row.locationNote ?? undefined,
      organizerEmail,
      organizerName: staff?.name ?? 'SimplexD',
      attendeeEmails:
        row.guestEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.guestEmail) ? [row.guestEmail] : [],
      url:
        active && row.conferenceStatus === 'ready' && row.meetingUrl ? row.meetingUrl : undefined,
      sequence: row.version,
      status:
        row.status === 'cancelled'
          ? 'CANCELLED'
          : row.status === 'pending_confirmation'
            ? 'TENTATIVE'
            : 'CONFIRMED',
      method: row.status === 'cancelled' ? 'CANCEL' : 'REQUEST',
    });
    return { fileName: icsFileName(summary), body };
  });
}
