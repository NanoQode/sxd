import { eq, sql } from 'drizzle-orm';
import {
  ApiError,
  type AppointmentDto,
  type CancelInput,
  type RescheduleInput,
} from '@simplexd/contracts';
import {
  appendOutbox,
  getDb,
  schema,
  systemContext,
  withActor,
  type Transaction,
} from '@simplexd/db';
import { appointmentMachine, evaluateTransition } from '@simplexd/domain/workflow';
import { recordAudit } from '@/lib/audit';
import {
  isStaffViewer,
  loadAppointment,
  loadAppointmentByManageToken,
  viewerIdentity,
  viewerUserId,
  type AppointmentRow,
  type Viewer,
} from './access';
import { businessZoneFor, staffNameFor } from './book';
import { isActiveStatus, toAppointmentDto } from './dto';
import { lockHold } from './holds';
import { enqueueCalendarCancel, enqueueCalendarSync } from './jobs';
import { loadBookingSettings } from './settings';

/**
 * Reschedule (atomic reservation swap against a fresh hold), cancel (releases
 * capacity and removes the calendar event) and Meet retry. Every change bumps
 * the appointment version, appends an outbox event for notifications and
 * enqueues the calendar job inside the same transaction.
 */

export interface MutateOptions {
  correlationId: string;
  now?: Date;
}

type Target = { kind: 'id'; viewer: Viewer; id: string } | { kind: 'token'; manageToken: string };

async function lockTarget(
  tx: Transaction,
  target: Target,
): Promise<{ row: AppointmentRow; viewer: Viewer }> {
  if (target.kind === 'token') {
    const row = await loadAppointmentByManageToken(tx, target.manageToken, { forUpdate: true });
    return { row, viewer: { kind: 'guest', manageToken: target.manageToken } };
  }
  const row = await loadAppointment(tx, target.viewer, target.id, { forUpdate: true });
  return { row, viewer: target.viewer };
}

function assertNotice(
  row: AppointmentRow,
  viewer: Viewer,
  minNoticeHours: number,
  now: Date,
  policy: string,
): void {
  if (isStaffViewer(viewer)) return;
  if (row.startsAt.getTime() - now.getTime() < minNoticeHours * 3600_000) {
    throw new ApiError(
      'deadline_passed',
      `changes are only possible up to ${minNoticeHours} hours before the start`,
      {
        details: { policy },
      },
    );
  }
}

async function loadSync(tx: Transaction, appointmentId: string) {
  const [sync] = await tx
    .select()
    .from(schema.eventSyncs)
    .where(eq(schema.eventSyncs.appointmentId, appointmentId));
  return sync ?? null;
}

async function finishDto(
  tx: Transaction,
  viewer: Viewer,
  id: string,
  now: Date,
  includeManagePath: boolean,
): Promise<AppointmentDto> {
  const [row] = await tx.select().from(schema.appointments).where(eq(schema.appointments.id, id));
  const settings = await loadBookingSettings(tx);
  const sync = await loadSync(tx, id);
  return toAppointmentDto(row!, {
    viewer,
    staffName: await staffNameFor(tx, row!.staffUserId),
    settings,
    sync,
    provider: sync?.calendarConnectionId ? 'google' : sync?.providerEventId ? 'dev' : null,
    includeManagePath,
    now,
  });
}

export async function rescheduleAppointment(
  target: Target,
  input: RescheduleInput,
  options: MutateOptions,
): Promise<AppointmentDto> {
  const now = options.now ?? new Date();
  return withActor(getDb(), systemContext(options.correlationId), async (tx) => {
    const { row, viewer } = await lockTarget(tx, target);
    if (!isActiveStatus(row.status)) {
      throw new ApiError('invalid_transition', `a ${row.status} appointment cannot be rescheduled`);
    }
    const settings = await loadBookingSettings(tx);
    assertNotice(row, viewer, settings.minNoticeHours, now, settings.cancellationPolicy);
    const hold = await lockHold(tx, input.holdToken, now);
    if (hold.kind && hold.kind !== row.kind) {
      throw new ApiError('validation_failed', 'the new hold is for a different appointment kind');
    }
    // Atomic swap: release the old reservation, promote the hold. Both happen
    // in this transaction, so the old slot never becomes free before the new
    // one is secured and no second reservation for this appointment exists.
    await tx
      .delete(schema.slotReservations)
      .where(eq(schema.slotReservations.appointmentId, row.id));
    await tx
      .update(schema.slotReservations)
      .set({ kind: 'appointment', appointmentId: row.id, expiresAt: null, holdToken: null })
      .where(eq(schema.slotReservations.id, hold.id));
    const sync = await loadSync(tx, row.id);
    const nextStatus =
      row.status === 'pending_confirmation'
        ? 'pending_confirmation'
        : (() => {
            const t = evaluateTransition(appointmentMachine, {
              from: row.status,
              to: 'rescheduled',
              actor: isStaffViewer(viewer) ? 'staff' : 'customer',
            });
            if (!t.ok) throw new ApiError('invalid_transition', t.message);
            return 'rescheduled' as const;
          })();
    const businessTimeZone =
      hold.staffUserId === row.staffUserId
        ? row.businessTimeZone
        : await businessZoneFor(tx, hold.staffUserId, settings.workingHours.timeZone);
    await tx
      .update(schema.appointments)
      .set({
        startsAt: hold.start,
        endsAt: hold.end,
        staffUserId: hold.staffUserId,
        businessTimeZone,
        status: nextStatus,
        calendarSyncStatus: sync ? 'pending' : row.calendarSyncStatus,
        remindersSent: [],
        version: sql`${schema.appointments.version} + 1`,
      })
      .where(eq(schema.appointments.id, row.id));
    let syncVersion = 0;
    if (sync) {
      syncVersion = sync.syncVersion + 1;
      await tx
        .update(schema.eventSyncs)
        .set({ syncVersion, status: sync.providerEventId ? sync.status : 'pending' })
        .where(eq(schema.eventSyncs.id, sync.id));
      await enqueueCalendarSync(tx, {
        appointmentId: row.id,
        syncVersion,
        organizationId: row.organizationId,
        actorUserId: viewerUserId(viewer),
        correlationId: options.correlationId,
      });
    }
    await appendOutbox(tx, {
      eventType: 'appointment.rescheduled',
      aggregateType: 'appointment',
      aggregateId: row.id,
      organizationId: row.organizationId,
      actorUserId: viewerUserId(viewer),
      payload: {
        appointmentId: row.id,
        previousStartsAt: row.startsAt.toISOString(),
        previousEndsAt: row.endsAt.toISOString(),
        startsAt: hold.start.toISOString(),
        endsAt: hold.end.toISOString(),
        staffUserId: hold.staffUserId,
        email: row.guestEmail,
        reason: input.reason ?? null,
      },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, viewerIdentity(viewer), {
      action: 'appointment.rescheduled',
      entityType: 'appointment',
      entityId: row.id,
      organizationId: row.organizationId,
      before: {
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        staffUserId: row.staffUserId,
      },
      after: {
        startsAt: hold.start.toISOString(),
        endsAt: hold.end.toISOString(),
        staffUserId: hold.staffUserId,
      },
      reason: input.reason ?? null,
      correlationId: options.correlationId,
    });
    return finishDto(tx, viewer, row.id, now, target.kind === 'token');
  });
}

export async function cancelAppointment(
  target: Target,
  input: CancelInput,
  options: MutateOptions,
): Promise<AppointmentDto> {
  const now = options.now ?? new Date();
  return withActor(getDb(), systemContext(options.correlationId), async (tx) => {
    const { row, viewer } = await lockTarget(tx, target);
    const transition = evaluateTransition(appointmentMachine, {
      from: row.status,
      to: 'cancelled',
      actor: isStaffViewer(viewer) ? 'staff' : 'customer',
      reason: input.reason,
    });
    if (!transition.ok) throw new ApiError('invalid_transition', transition.message);
    const settings = await loadBookingSettings(tx);
    assertNotice(row, viewer, settings.minNoticeHours, now, settings.cancellationPolicy);
    await tx
      .delete(schema.slotReservations)
      .where(eq(schema.slotReservations.appointmentId, row.id));
    const sync = await loadSync(tx, row.id);
    const needsProviderCancel = Boolean(sync?.providerEventId);
    await tx
      .update(schema.appointments)
      .set({
        status: 'cancelled',
        cancellationReason: input.reason,
        cancelledBy: viewerUserId(viewer),
        cancelledAt: now,
        calendarSyncStatus: needsProviderCancel ? 'pending' : 'cancelled',
        version: sql`${schema.appointments.version} + 1`,
      })
      .where(eq(schema.appointments.id, row.id));
    if (sync) {
      if (needsProviderCancel) {
        await enqueueCalendarCancel(tx, {
          appointmentId: row.id,
          organizationId: row.organizationId,
          actorUserId: viewerUserId(viewer),
          correlationId: options.correlationId,
        });
      } else {
        await tx
          .update(schema.eventSyncs)
          .set({ status: 'cancelled' })
          .where(eq(schema.eventSyncs.id, sync.id));
      }
    }
    await appendOutbox(tx, {
      eventType: 'appointment.cancelled',
      aggregateType: 'appointment',
      aggregateId: row.id,
      organizationId: row.organizationId,
      actorUserId: viewerUserId(viewer),
      payload: {
        appointmentId: row.id,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        staffUserId: row.staffUserId,
        email: row.guestEmail,
        reason: input.reason,
        cancelledByStaff: isStaffViewer(viewer),
      },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, viewerIdentity(viewer), {
      action: 'appointment.cancelled',
      entityType: 'appointment',
      entityId: row.id,
      organizationId: row.organizationId,
      before: { status: row.status },
      after: { status: 'cancelled' },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    return finishDto(tx, viewer, row.id, now, target.kind === 'token');
  });
}

/** Staff: pending_confirmation → confirmed. */
export async function confirmAppointment(
  viewer: Viewer,
  id: string,
  options: MutateOptions,
): Promise<AppointmentDto> {
  const now = options.now ?? new Date();
  if (!isStaffViewer(viewer)) throw new ApiError('forbidden', 'only staff confirm appointments');
  return withActor(getDb(), systemContext(options.correlationId), async (tx) => {
    const row = await loadAppointment(tx, viewer, id, { forUpdate: true });
    const transition = evaluateTransition(appointmentMachine, {
      from: row.status,
      to: 'confirmed',
      actor: 'staff',
    });
    if (!transition.ok) throw new ApiError('invalid_transition', transition.message);
    await tx
      .update(schema.appointments)
      .set({ status: 'confirmed', version: sql`${schema.appointments.version} + 1` })
      .where(eq(schema.appointments.id, id));
    await appendOutbox(tx, {
      eventType: 'appointment.confirmed',
      aggregateType: 'appointment',
      aggregateId: id,
      organizationId: row.organizationId,
      actorUserId: viewerUserId(viewer),
      payload: { appointmentId: id, email: row.guestEmail },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, viewerIdentity(viewer), {
      action: 'appointment.confirmed',
      entityType: 'appointment',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status },
      after: { status: 'confirmed' },
      correlationId: options.correlationId,
    });
    return finishDto(tx, viewer, id, now, false);
  });
}

/**
 * Staff: ask the provider for a new Meet conference (new request id) after a
 * failed conference, or re-run a failed calendar sync. Never invents a link:
 * the worker reports the real provider outcome.
 */
export async function retryCalendarSync(
  viewer: Viewer,
  id: string,
  options: MutateOptions,
): Promise<AppointmentDto> {
  const now = options.now ?? new Date();
  if (viewer.kind !== 'staff' || !viewer.manageAll) {
    throw new ApiError('forbidden', 'appointments.manage_all is required to retry calendar sync');
  }
  return withActor(getDb(), systemContext(options.correlationId), async (tx) => {
    const row = await loadAppointment(tx, viewer, id, { forUpdate: true });
    if (!isActiveStatus(row.status)) {
      throw new ApiError('invalid_transition', `a ${row.status} appointment has nothing to sync`);
    }
    const sync = await loadSync(tx, id);
    if (!sync) throw new ApiError('conflict', 'this appointment has no calendar sync record');
    const retryConference =
      row.meetingProvider === 'google_meet' &&
      (row.conferenceStatus === 'failed' || sync.conferenceStatus === 'failed');
    await tx
      .update(schema.appointments)
      .set({ calendarSyncStatus: 'pending' })
      .where(eq(schema.appointments.id, id));
    await enqueueCalendarSync(tx, {
      appointmentId: id,
      syncVersion: sync.syncVersion,
      organizationId: row.organizationId,
      actorUserId: viewer.userId,
      correlationId: options.correlationId,
      retryConference,
      nonce: `${now.getTime()}`,
    });
    await recordAudit(tx, viewer.identity, {
      action: retryConference
        ? 'appointment.meet_retry_requested'
        : 'appointment.sync_retry_requested',
      entityType: 'appointment',
      entityId: id,
      organizationId: row.organizationId,
      correlationId: options.correlationId,
    });
    return finishDto(tx, viewer, id, now, false);
  });
}
