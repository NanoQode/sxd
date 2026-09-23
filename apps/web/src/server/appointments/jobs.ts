import { enqueueJob, type DbExecutor } from '@simplexd/db';

/**
 * Job types shared with apps/worker/src/handlers/calendar.ts. The worker owns
 * the handlers; the web app only enqueues inside the booking transaction so a
 * job exists if and only if the appointment change committed.
 */
export const CALENDAR_JOBS = {
  syncEvent: 'calendar.sync_event',
  cancelEvent: 'calendar.cancel_event',
  reconcileConferences: 'calendar.reconcile_pending_conferences',
  renewWatchChannels: 'calendar.renew_watch_channels',
  processPush: 'calendar.process_push',
  scanReminders: 'appointments.scan_reminders',
} as const;

export const CALENDAR_QUEUE = 'calendar';

export async function enqueueCalendarSync(
  tx: DbExecutor,
  input: {
    appointmentId: string;
    syncVersion: number;
    organizationId: string | null;
    actorUserId: string | null;
    correlationId: string | null;
    /** Generates a new conference request id and asks the provider for a fresh Meet. */
    retryConference?: boolean;
    /** Force a distinct job even for the same sync version (manual resync). */
    nonce?: string;
  },
): Promise<string> {
  const suffix = input.retryConference ? `:meet:${input.nonce ?? Date.now()}` : input.nonce ? `:${input.nonce}` : '';
  const { id } = await enqueueJob(tx, {
    type: CALENDAR_JOBS.syncEvent,
    queue: CALENDAR_QUEUE,
    payload: { appointmentId: input.appointmentId, retryConference: input.retryConference ?? false },
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
    dedupeKey: `${CALENDAR_JOBS.syncEvent}:${input.appointmentId}:v${input.syncVersion}${suffix}`,
  });
  return id;
}

export async function enqueueCalendarCancel(
  tx: DbExecutor,
  input: {
    appointmentId: string;
    organizationId: string | null;
    actorUserId: string | null;
    correlationId: string | null;
  },
): Promise<string> {
  const { id } = await enqueueJob(tx, {
    type: CALENDAR_JOBS.cancelEvent,
    queue: CALENDAR_QUEUE,
    payload: { appointmentId: input.appointmentId },
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
    dedupeKey: `${CALENDAR_JOBS.cancelEvent}:${input.appointmentId}`,
  });
  return id;
}
