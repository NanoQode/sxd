import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { claimJobs, completeJob, failJob, schema, systemContext, withActor } from '@simplexd/db';
import { dispatchRequest } from './dispatch';
import { resolveEnv } from './env';
import { dispatchOutboxEvent } from './registry';
import { DEFERRED_QUEUE, ProviderSet, executeDeferredSend, type DeferredJobPayload } from './send';
import type { Db, NotificationCategory, PipelineOptions } from './types';

/**
 * Scheduled work: quiet-hour deferrals whose send time has passed, booking
 * reminders, and daily/weekly digests that bundle in-app items for people
 * who asked for a summary instead of individual emails.
 */

export interface ReminderSweepResult {
  deferredSent: number;
  deferredFailed: number;
  bookingReminders: number;
}

export async function sendDueReminders(db: Db, options: PipelineOptions = {}): Promise<ReminderSweepResult> {
  const env = resolveEnv(options);
  const providers = new ProviderSet(db, env);
  const result: ReminderSweepResult = { deferredSent: 0, deferredFailed: 0, bookingReminders: 0 };
  const now = env.now();

  // 1. Deferred (quiet hours) sends whose send_at has passed.
  for (let round = 0; round < 20; round += 1) {
    const jobs = await withActor(db, systemContext('reminders'), (tx) =>
      claimJobs(tx, { workerId: 'notifications-reminders', queues: [DEFERRED_QUEUE], limit: 25, now }),
    );
    if (jobs.length === 0) break;
    for (const job of jobs) {
      try {
        const outcome = await executeDeferredSend(db, job.payload as unknown as DeferredJobPayload, env, providers);
        if (outcome?.status === 'failed' && outcome.retryable) throw new Error(outcome.errorSanitized ?? 'retryable send failure');
        await withActor(db, systemContext('reminders'), (tx) => completeJob(tx, job.id));
        if (outcome && outcome.status !== 'failed') result.deferredSent += 1;
        else result.deferredFailed += 1;
      } catch (err) {
        result.deferredFailed += 1;
        await withActor(db, systemContext('reminders'), (tx) => failJob(tx, job, err));
      }
    }
  }

  // 2. Booking reminders 24h ahead for confirmed appointments.
  const windowEnd = new Date(now.getTime() + 24 * 60 * 60_000);
  const due = await withActor(db, systemContext('reminders'), (tx) =>
    tx
      .select({ id: schema.appointments.id, remindersSent: schema.appointments.remindersSent, organizationId: schema.appointments.organizationId })
      .from(schema.appointments)
      .where(
        and(
          inArray(schema.appointments.status, ['confirmed', 'rescheduled']),
          gt(schema.appointments.startsAt, now),
          lte(schema.appointments.startsAt, windowEnd),
        ),
      )
      .orderBy(asc(schema.appointments.startsAt))
      .limit(200),
  );
  for (const appt of due) {
    const sent = appt.remindersSent ?? [];
    if (sent.includes('24h')) continue;
    await dispatchOutboxEvent(
      db,
      {
        id: `reminder-24h-${appt.id}`,
        type: 'appointment.reminder_due',
        aggregateType: 'appointment',
        aggregateId: appt.id,
        payload: { appointmentId: appt.id, window: '24h' },
        organizationId: appt.organizationId,
      },
      options,
    );
    await withActor(db, systemContext('reminders'), (tx) =>
      tx
        .update(schema.appointments)
        .set({ remindersSent: [...sent, '24h'] })
        .where(eq(schema.appointments.id, appt.id)),
    );
    result.bookingReminders += 1;
  }
  return result;
}

export interface DigestResult {
  usersConsidered: number;
  digestsSent: number;
  skipped: number;
}

const DIGEST_CATEGORIES: NotificationCategory[] = ['transactional', 'reminders', 'digests'];

/**
 * Bundles unread in-app items for users whose email preference for a
 * category is `daily` or `weekly`. One digest per user per period; the
 * last digest is the newest `digest` delivery attempt for that user.
 */
export async function sendDigests(db: Db, options: PipelineOptions = {}): Promise<DigestResult> {
  const env = resolveEnv(options);
  const now = env.now();
  const result: DigestResult = { usersConsidered: 0, digestsSent: 0, skipped: 0 };
  const prefs = await withActor(db, systemContext('digests'), (tx) =>
    tx
      .select()
      .from(schema.notificationPreferences)
      .where(
        and(
          eq(schema.notificationPreferences.channel, 'email'),
          inArray(schema.notificationPreferences.digest, ['daily', 'weekly']),
          eq(schema.notificationPreferences.enabled, true),
          inArray(schema.notificationPreferences.category, DIGEST_CATEGORIES),
        ),
      ),
  );
  const byUser = new Map<string, { period: 'daily' | 'weekly'; categories: NotificationCategory[] }>();
  for (const p of prefs) {
    const entry = byUser.get(p.userId) ?? { period: 'weekly', categories: [] };
    if (p.digest === 'daily') entry.period = 'daily';
    entry.categories.push(p.category);
    byUser.set(p.userId, entry);
  }
  for (const [userId, { period, categories }] of byUser) {
    result.usersConsidered += 1;
    const minGapMs = (period === 'daily' ? 24 : 7 * 24) * 60 * 60_000 - 60_000;
    const { last, items, user } = await withActor(db, systemContext('digests'), async (tx) => {
      const [last] = await tx
        .select({ sentAt: schema.deliveryAttempts.sentAt, queuedAt: schema.deliveryAttempts.queuedAt })
        .from(schema.deliveryAttempts)
        .where(
          and(
            eq(schema.deliveryAttempts.userId, userId),
            eq(schema.deliveryAttempts.templateKey, 'digest'),
            inArray(schema.deliveryAttempts.status, ['sent', 'accepted', 'delivered']),
          ),
        )
        .orderBy(desc(schema.deliveryAttempts.queuedAt))
        .limit(1);
      const since = last?.sentAt ?? last?.queuedAt ?? null;
      const items = await tx
        .select()
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.userId, userId),
            inArray(schema.notifications.category, categories),
            isNull(schema.notifications.readAt),
            since ? gte(schema.notifications.createdAt, since) : sql`true`,
          ),
        )
        .orderBy(desc(schema.notifications.createdAt))
        .limit(50);
      const [user] = await tx.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, userId));
      return { last: since, items, user };
    });
    if (!user || items.length === 0 || (last && now.getTime() - last.getTime() < minGapMs)) {
      result.skipped += 1;
      continue;
    }
    const bucket = period === 'daily' ? now.toISOString().slice(0, 10) : `${now.getUTCFullYear()}-w${isoWeek(now)}`;
    const outcome = await dispatchRequest(
      db,
      {
        templateKey: 'digest',
        category: 'digests',
        channels: ['email'],
        recipients: [{ userId }],
        variables: {
          name: user.name,
          period,
          count: items.length,
          items: items.map((i) => `- ${i.title}${i.body ? `: ${i.body}` : ''}${i.linkPath ? ` (${env.appUrl}${i.linkPath})` : ''}`).join('\n'),
          appUrl: env.appUrl,
        },
        dedupeScope: `digest:${period}:${bucket}`,
        ignorePreferences: true,
        relatedEntity: { type: 'digest', id: null },
      },
      options,
    );
    if (outcome.outcomes.some((o) => o.status === 'sent' || o.status === 'accepted')) result.digestsSent += 1;
    else result.skipped += 1;
  }
  return result;
}

function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}
