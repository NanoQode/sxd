import 'server-only';
import { and, eq } from 'drizzle-orm';
import { enqueueJob, getDb, schema, systemContext, withActor } from '@simplexd/db';
import { validatePushNotification, type HeaderSource } from '@simplexd/integrations/google';
import { CALENDAR_JOBS, CALENDAR_QUEUE } from '@/server/appointments/jobs';

/**
 * Google push receiver. The request carries no body; after the channel token
 * matches the stored hash an incremental sync job is queued. Nothing about
 * the event is derived from the notification itself. Google retries only on
 * 5xx, so validation failures answer with the 4xx the helper recommends and
 * successes always answer 200 quickly.
 */
export interface PushOutcome {
  status: 200 | 400 | 403 | 404;
  action: 'acknowledged' | 'queued' | 'rejected';
  reason?: string;
}

export async function handleCalendarPush(headers: HeaderSource, correlationId: string): Promise<PushOutcome> {
  const validated = await validatePushNotification(headers, async (channelId) => {
    const [row] = await withActor(getDb(), systemContext(correlationId), (tx) =>
      tx
        .select({ tokenHash: schema.calendarWatchChannels.tokenHash })
        .from(schema.calendarWatchChannels)
        .where(
          and(
            eq(schema.calendarWatchChannels.channelId, channelId),
            eq(schema.calendarWatchChannels.status, 'active'),
          ),
        ),
    );
    return row?.tokenHash ?? null;
  });
  if (!validated.ok) {
    return { status: validated.respondWithStatus, action: 'rejected', reason: validated.reason };
  }
  const { notification } = validated;
  await withActor(getDb(), systemContext(correlationId), async (tx) => {
    await tx
      .update(schema.calendarWatchChannels)
      .set({ lastNotificationAt: new Date() })
      .where(eq(schema.calendarWatchChannels.channelId, notification.channelId));
    if (validated.action === 'fetch_changes') {
      // Coalesce bursts: one sync job per channel per ten seconds.
      const bucket = Math.floor(Date.now() / 10_000);
      await enqueueJob(tx, {
        type: CALENDAR_JOBS.processPush,
        queue: CALENDAR_QUEUE,
        payload: { channelId: notification.channelId, resourceState: notification.resourceState },
        dedupeKey: `${CALENDAR_JOBS.processPush}:${notification.channelId}:${bucket}`,
        correlationId,
      });
    }
  });
  return {
    status: 200,
    action: validated.action === 'fetch_changes' ? 'queued' : 'acknowledged',
  };
}
