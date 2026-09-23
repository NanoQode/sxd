import {
  DEFERRED_JOB_TYPE,
  dispatchOutboxEvent,
  executeDeferredSend,
  processBounce,
  resolveEnv,
  sendDigests,
  sendDueReminders,
  type DeferredJobPayload,
  type OutboxEventLike,
  type PipelineOptions,
} from '@simplexd/notifications';
import { NonRetryableJobError, type JobContext, type JobRunner } from '../runner';

/**
 * Notification delivery jobs (brief §13/§14). Every outbox-routed event
 * lands in `notifications.dispatch` (the legacy per-event job types are kept
 * so queued jobs from earlier builds still run). Attempts are deduplicated
 * per event × recipient × channel inside the pipeline, so a job retry never
 * sends twice; the job only fails when the provider asked for a retry.
 */

const LEGACY_DISPATCH_TYPES = [
  'notifications.deliver',
  'notifications.lead_created',
  'notifications.engagement_transition',
  'notifications.quote_issued',
  'notifications.invoice_issued',
  'notifications.payment_receipt',
  'notifications.booking_confirmation',
  'notifications.visit_change',
  'notifications.report_ready',
  'notifications.urgent_decision',
  'notifications.tender_invitation',
  'notifications.award_published',
  'notifications.work_order',
  'notifications.invitation',
  'notifications.admin_setup',
];

function pipelineOptions(ctx: JobContext): PipelineOptions {
  return {
    log: {
      info: (obj, msg) => ctx.log.info(obj, msg),
      warn: (obj, msg) => ctx.log.warn(obj, msg),
      error: (obj, msg) => ctx.log.error(obj, msg),
    },
  };
}

function eventFromJob(ctx: JobContext): OutboxEventLike | null {
  const payload = ctx.job.payload as { event?: Partial<OutboxEventLike> } | null;
  const event = payload?.event;
  if (!event || typeof event.type !== 'string') return null;
  return {
    id: event.id ?? ctx.job.id,
    type: event.type,
    aggregateType: event.aggregateType ?? 'unknown',
    aggregateId: event.aggregateId ?? '',
    payload: event.payload ?? {},
    organizationId: ctx.job.organizationId,
    actorUserId: ctx.job.actorUserId,
    correlationId: ctx.job.correlationId,
  };
}

export function registerNotificationHandlers(runner: JobRunner): void {
  const dispatch = async (ctx: JobContext) => {
    const event = eventFromJob(ctx);
    if (!event) {
      ctx.log.warn(
        { payloadKeys: Object.keys(ctx.job.payload as object) },
        'notification job without an event payload; skipped',
      );
      return;
    }
    const result = await dispatchOutboxEvent(ctx.db, event, pipelineOptions(ctx));
    const summary = result.outcomes.reduce<Record<string, number>>((acc, o) => {
      acc[o.status] = (acc[o.status] ?? 0) + 1;
      return acc;
    }, {});
    ctx.log.info(
      { eventType: event.type, handled: result.handled, requests: result.requests, summary },
      'notification dispatch',
    );
    if (result.retryable) {
      throw new Error(
        `retryable provider failure for ${event.type}: ${result.outcomes
          .filter((o) => o.retryable)
          .map((o) => o.reason)
          .join('; ')}`,
      );
    }
  };

  runner.register('notifications.dispatch', dispatch);
  for (const type of LEGACY_DISPATCH_TYPES) runner.register(type, dispatch);

  runner.register(DEFERRED_JOB_TYPE, async (ctx) => {
    const payload = ctx.job.payload as unknown as DeferredJobPayload;
    if (!payload?.attemptId || !payload.message)
      throw new NonRetryableJobError('deferred send payload is incomplete');
    const outcome = await executeDeferredSend(ctx.db, payload, resolveEnv(pipelineOptions(ctx)));
    if (outcome?.status === 'failed' && outcome.retryable)
      throw new Error(outcome.errorSanitized ?? 'retryable send failure');
  });

  runner.register('notifications.send_due_reminders', async (ctx) => {
    // The calendar scan routes `appointment.reminder_due` events here; a scheduled tick has no event.
    const event = eventFromJob(ctx);
    if (event) {
      await dispatch(ctx);
      return;
    }
    const result = await sendDueReminders(ctx.db, pipelineOptions(ctx));
    if (result.deferredSent || result.deferredFailed) ctx.log.info(result, 'deferred send sweep');
  });

  runner.register('notifications.send_digests', async (ctx) => {
    const result = await sendDigests(ctx.db, pipelineOptions(ctx));
    if (result.digestsSent > 0) ctx.log.info(result, 'digests sent');
  });

  runner.register('notifications.process_bounce', async (ctx) => {
    const payload = ctx.job.payload as {
      email?: string;
      kind?: 'hard' | 'soft' | 'complaint';
      reason?: string;
      providerMessageId?: string;
      source?: string;
    };
    if (!payload.email) throw new NonRetryableJobError('bounce payload needs an email');
    const result = await processBounce(
      ctx.db,
      {
        email: payload.email,
        kind: payload.kind ?? 'hard',
        reason: payload.reason ?? null,
        providerMessageId: payload.providerMessageId ?? null,
        source: payload.source ?? 'job',
      },
      pipelineOptions(ctx),
    );
    ctx.log.info(
      { attemptId: result.attemptId, suppressed: result.suppressed },
      'bounce processed',
    );
  });
}
