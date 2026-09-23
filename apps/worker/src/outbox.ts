import type { Logger } from 'pino';
import {
  claimOutboxBatch,
  enqueueJob,
  markOutboxFailed,
  markOutboxPublished,
  systemContext,
  withActor,
  type Database,
  type OutboxRow,
} from '@simplexd/db';

/**
 * Maps business events to jobs. Each mapping is idempotent through the job
 * dedupe key, so replaying an outbox row never duplicates side effects.
 */
export type OutboxRoute = (event: OutboxRow) => Array<{
  type: string;
  queue?: string;
  payload?: Record<string, unknown>;
  dedupeSuffix?: string;
}>;

const routes: Record<string, OutboxRoute> = {
  'lead.created': () => [{ type: 'notifications.lead_created', queue: 'notifications' }],
  'service_request.transitioned': (e) => [
    {
      type: 'notifications.engagement_transition',
      queue: 'notifications',
      payload: { ...(e.payload as object) },
    },
  ],
  'quote.issued': () => [{ type: 'notifications.quote_issued', queue: 'notifications' }],
  'invoice.issued': () => [{ type: 'notifications.invoice_issued', queue: 'notifications' }],
  'payment.verified': () => [
    { type: 'finance.post_payment', queue: 'payments' },
    { type: 'notifications.payment_receipt', queue: 'notifications' },
  ],
  'payment.event_received': () => [{ type: 'payments.process_provider_event', queue: 'payments' }],
  'refund.approved': () => [{ type: 'payments.submit_refund', queue: 'payments' }],
  // Calendar jobs are enqueued inside the booking transaction (see
  // apps/web/src/server/appointments/jobs.ts); outbox events only fan out notifications.
  'appointment.booked': () => [
    { type: 'notifications.booking_confirmation', queue: 'notifications' },
  ],
  'appointment.confirmed': () => [
    { type: 'notifications.booking_confirmation', queue: 'notifications' },
  ],
  'appointment.rescheduled': () => [{ type: 'notifications.visit_change', queue: 'notifications' }],
  'appointment.cancelled': () => [{ type: 'notifications.visit_change', queue: 'notifications' }],
  'appointment.sync_conflict': () => [
    { type: 'notifications.urgent_decision', queue: 'notifications' },
  ],
  'appointment.reminder_due': (e) => [
    {
      type: 'notifications.send_due_reminders',
      queue: 'notifications',
      payload: { reminder: { ...(e.payload as object) } },
    },
  ],
  'report.released': () => [{ type: 'notifications.report_ready', queue: 'notifications' }],
  'change_order.submitted': () => [
    { type: 'notifications.urgent_decision', queue: 'notifications' },
  ],
  'file.uploaded': () => [{ type: 'media.scan_and_process', queue: 'media' }],
  'tender.published': () => [{ type: 'notifications.tender_invitation', queue: 'notifications' }],
  'award.published': () => [{ type: 'notifications.award_published', queue: 'notifications' }],
  'market_data.published': () => [{ type: 'market_data.invalidate_caches', queue: 'default' }],
  'notification.requested': () => [{ type: 'notifications.deliver', queue: 'notifications' }],
  'integration.degraded': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'work_order.transitioned': () => [{ type: 'notifications.work_order', queue: 'notifications' }],
  'invitation.created': () => [{ type: 'notifications.invitation', queue: 'notifications' }],
  'setup_token.issued': () => [{ type: 'notifications.admin_setup', queue: 'notifications' }],
  // Engagement, invoicing and payment orchestration (@simplexd/finance).
  'quote.accepted': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'quote.expired': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'invoice.paid': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'invoice.partially_paid': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'invoice.voided': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'payment.reversed': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'bank_transfer.declared': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'bank_transfer.rejected': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'refund.requested': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'refund.settled': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'refund.failed': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'credit_note.issued': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'chargeback.opened': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  // Consumed by @simplexd/notifications (event registry); one dispatch job per event.
  'lead.invited': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'engagement.transitioned': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'payment.settled': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'project.report.released': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'project.status_changed': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'task.assigned': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'message.posted': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  // Tendering and procurement (services enqueue publish/award jobs directly; these are notifications).
  'tender.invitation.sent': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'tender.revised': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'tender.question.asked': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'tender.question.answered': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'tender.closed': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'tender.bids_opened': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'tender.cancelled': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'tender.award.published': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'tender.award.responded': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'bid.submitted': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'rfq.issued': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'rfq.response.submitted': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'purchase_order.issued': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'purchase_order.cancelled': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'delivery.recorded': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'delivery.discrepancy.opened': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'delivery.discrepancy.supplier_notified': () => [
    { type: 'notifications.dispatch', queue: 'notifications' },
  ],
};

export function routeOutboxEvent(event: OutboxRow): ReturnType<OutboxRoute> {
  const route = routes[event.eventType];
  return route ? route(event) : [];
}

export function runOutboxRelay(opts: {
  db: Database;
  log: Logger;
  intervalMs: number;
  batch?: number;
}): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const loop = async () => {
    if (stopped) return;
    try {
      const processed = await withActor(opts.db, systemContext('outbox-relay'), async (tx) => {
        const events = await claimOutboxBatch(tx, opts.batch ?? 50);
        const done: number[] = [];
        for (const event of events) {
          try {
            for (const target of routeOutboxEvent(event)) {
              await enqueueJob(tx, {
                type: target.type,
                queue: target.queue ?? 'default',
                payload: {
                  event: {
                    id: event.id,
                    type: event.eventType,
                    aggregateType: event.aggregateType,
                    aggregateId: event.aggregateId,
                    payload: event.payload,
                  },
                  ...(target.payload ?? {}),
                },
                organizationId: event.organizationId,
                actorUserId: event.actorUserId,
                correlationId: event.correlationId,
                dedupeKey: `outbox:${event.id}:${target.type}${target.dedupeSuffix ?? ''}`,
              });
            }
            done.push(event.id);
          } catch (err) {
            await markOutboxFailed(tx, event.id, err);
            opts.log.error({ err, outboxId: event.id }, 'outbox routing failed');
          }
        }
        await markOutboxPublished(tx, done);
        return events.length;
      });
      timer = setTimeout(() => void loop(), processed > 0 ? 0 : opts.intervalMs);
    } catch (err) {
      opts.log.error({ err }, 'outbox relay failed');
      timer = setTimeout(() => void loop(), opts.intervalMs * 5);
    }
  };
  void loop();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
