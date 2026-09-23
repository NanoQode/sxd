import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  ApiError,
  type AppointmentDto,
  type AppointmentKind,
  type BookingCreate,
} from '@simplexd/contracts';
import {
  appendOutbox,
  getDb,
  schema,
  systemContext,
  withActor,
  type DbExecutor,
} from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { viewerFromIdentity, guestViewer } from './access';
import { toAppointmentDto } from './dto';
import { lockHold } from './holds';
import { enqueueCalendarSync } from './jobs';
import { isGuestBookable, loadBookingSettings, meetingProviderForKind } from './settings';

/**
 * Converts a live hold into an appointment. Runs as the system actor after the
 * application-level checks so the reservation swap, the event_syncs row, the
 * calendar job and the outbox event commit together. Guests (no session) may
 * book only the kinds listed in booking settings and must give a name, email
 * and phone; signed-in customers are linked to their active organisation.
 */

export interface CreateBookingOptions {
  identity: RequestIdentity | null;
  correlationId: string;
  now?: Date;
}

function token(): string {
  return randomBytes(24).toString('base64url');
}

export async function staffNameFor(tx: DbExecutor, userId: string): Promise<string> {
  const [row] = await tx
    .select({ name: schema.user.name })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  return row?.name ?? 'SimplexD team';
}

export async function businessZoneFor(
  tx: DbExecutor,
  staffUserId: string,
  fallback: string,
): Promise<string> {
  const [row] = await tx
    .select({ timeZone: schema.staffAvailability.timeZone })
    .from(schema.staffAvailability)
    .where(
      and(
        eq(schema.staffAvailability.staffUserId, staffUserId),
        eq(schema.staffAvailability.active, true),
      ),
    )
    .limit(1);
  return row?.timeZone ?? fallback;
}

export async function createBooking(
  input: BookingCreate,
  options: CreateBookingOptions,
): Promise<AppointmentDto> {
  const now = options.now ?? new Date();
  const identity = options.identity?.session ? options.identity : null;
  if (!identity && !input.guest) {
    throw new ApiError('validation_failed', 'guest bookings need a name, email and phone number', {
      details: { path: 'guest' },
    });
  }
  const correlationId = options.correlationId;
  return withActor(getDb(), systemContext(correlationId), async (tx) => {
    const hold = await lockHold(tx, input.holdToken, now);
    const kind: AppointmentKind = hold.kind ?? input.kind ?? 'consultation';
    if (input.kind && hold.kind && input.kind !== hold.kind) {
      throw new ApiError(
        'validation_failed',
        'the hold was taken for a different appointment kind',
        {
          details: { holdKind: hold.kind, requestedKind: input.kind },
        },
      );
    }
    const settings = await loadBookingSettings(tx);
    if (!identity && !isGuestBookable(settings, kind)) {
      throw new ApiError('unauthenticated', 'sign in to book this kind of appointment');
    }
    let guestName: string;
    let guestEmail: string;
    let guestPhone: string | null;
    if (identity) {
      guestName = identity.session!.user.name;
      guestEmail = identity.session!.user.email.toLowerCase();
      const [profile] = await tx
        .select({ phoneE164: schema.userProfiles.phoneE164 })
        .from(schema.userProfiles)
        .where(eq(schema.userProfiles.userId, identity.session!.user.id));
      guestPhone = input.guest?.phoneE164 ?? profile?.phoneE164 ?? null;
    } else {
      guestName = input.guest!.name;
      guestEmail = input.guest!.email.toLowerCase();
      guestPhone = input.guest!.phoneE164;
    }
    const staffName = await staffNameFor(tx, hold.staffUserId);
    const businessTimeZone = await businessZoneFor(
      tx,
      hold.staffUserId,
      settings.workingHours.timeZone,
    );
    const meetingProvider = meetingProviderForKind(kind);
    const status = settings.autoConfirm ? 'confirmed' : 'pending_confirmation';
    const leadId = input.leadId
      ? ((
          await tx
            .select({ id: schema.leads.id })
            .from(schema.leads)
            .where(eq(schema.leads.id, input.leadId))
        )[0]?.id ?? null)
      : null;
    const [appointment] = await tx
      .insert(schema.appointments)
      .values({
        organizationId: identity?.ctx.organizationId ?? null,
        kind,
        status,
        staffUserId: hold.staffUserId,
        customerUserId: identity?.session?.user.id ?? null,
        guestName,
        guestEmail,
        guestPhoneE164: guestPhone,
        startsAt: hold.start,
        endsAt: hold.end,
        customerTimeZone: input.customerTimeZone,
        businessTimeZone,
        topic: input.topic ?? null,
        notes: input.notes ?? null,
        meetingProvider,
        calendarSyncStatus: 'pending',
        conferenceStatus: meetingProvider === 'google_meet' ? 'pending' : 'none',
        leadId,
        serviceRequestId: input.serviceRequestId ?? null,
        icsToken: token(),
        manageToken: token(),
        remindersSent: [],
      })
      .returning();
    const row = appointment!;
    await tx
      .update(schema.slotReservations)
      .set({ kind: 'appointment', appointmentId: row.id, expiresAt: null, holdToken: null })
      .where(eq(schema.slotReservations.id, hold.id));
    await tx.insert(schema.eventSyncs).values({
      appointmentId: row.id,
      conferenceRequestId: randomUUID(),
      status: 'pending',
      conferenceStatus: meetingProvider === 'google_meet' ? 'pending' : 'none',
      syncVersion: 0,
    });
    await enqueueCalendarSync(tx, {
      appointmentId: row.id,
      syncVersion: 0,
      organizationId: row.organizationId,
      actorUserId: row.customerUserId,
      correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'appointment.booked',
      aggregateType: 'appointment',
      aggregateId: row.id,
      organizationId: row.organizationId,
      actorUserId: row.customerUserId,
      payload: {
        appointmentId: row.id,
        kind,
        status,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        staffUserId: row.staffUserId,
        guest: !identity,
        email: guestEmail,
        customerTimeZone: row.customerTimeZone,
        businessTimeZone,
      },
      correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'appointment.booked',
      entityType: 'appointment',
      entityId: row.id,
      organizationId: row.organizationId,
      after: {
        kind,
        status,
        staffUserId: row.staffUserId,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        guest: !identity,
      },
      correlationId,
    });
    const viewer = identity ? viewerFromIdentity(identity) : guestViewer(row.manageToken!);
    return toAppointmentDto(row, {
      viewer,
      staffName,
      settings,
      includeManagePath: true,
      now,
    });
  });
}
