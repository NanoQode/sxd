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
  type Transaction,
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
  // Monitoring thresholds crossed (apps/worker/src/monitoring), at most one per key per hour.
  'ops.alert': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
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
  // Engagement records (apps/web/src/server/engagements): assignee, customer and staff notices.
  'engagement_item.assigned': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'engagement_item.customer_action': () => [
    { type: 'notifications.dispatch', queue: 'notifications' },
  ],
  'engagement_item.responded': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'engagement_item.evidence_attached': () => [
    { type: 'notifications.dispatch', queue: 'notifications' },
  ],
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
  // Property management (apps/web/src/server/rentals, apps/web/src/server/maintenance); the
  // rent and SLA jobs are scheduled, so these events only fan out notifications.
  'tenant.invited': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'tenant.notice': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'lease.transitioned': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'lease.renewed': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'rent.invoice_issued': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'rent.overdue': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'owner_statement.issued': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'payout.transitioned': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'work_order.sla_breached': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  // Property search and purchase representation (apps/web/src/server/search, .../purchase).
  'shortlist.shared': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'shortlist.accepted': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'shortlist.outcome_recorded': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'viewing.requested': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'viewing.updated': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'purchase_offer.updated': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'purchase_item.created': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'purchase_handover.ready': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
  'purchase_handover.acknowledged': () => [
    { type: 'notifications.dispatch', queue: 'notifications' },
  ],
  'purchase_closing.submitted': () => [{ type: 'notifications.dispatch', queue: 'notifications' }],
};

export function routeOutboxEvent(event: OutboxRow): ReturnType<OutboxRoute> {
  const route = routes[event.eventType];
  return route ? route(event) : [];
}

/** Event types the relay routes (tests check every target has a handler). */
export function routedEventTypes(): string[] {
  return Object.keys(routes);
}

/**
 * Routes claimed outbox events into jobs inside the relay's transaction. Each
 * event runs in its own savepoint, so a failing event (routing error or a
 * database error while enqueueing) is counted with `markOutboxFailed` without
 * aborting the rest of the batch. Exported for tests.
 */
export async function relayOutboxEvents(
  tx: Transaction,
  events: OutboxRow[],
  log: Pick<Logger, 'error'>,
  route: (event: OutboxRow) => ReturnType<OutboxRoute> = routeOutboxEvent,
): Promise<{ published: number[]; failed: number[] }> {
  const published: number[] = [];
  const failed: number[] = [];
  for (const event of events) {
    try {
      await tx.transaction(async (sp) => {
        for (const target of route(event)) {
          await enqueueJob(sp, {
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
      });
      published.push(event.id);
    } catch (err) {
      await markOutboxFailed(tx, event.id, err);
      failed.push(event.id);
      log.error({ err, outboxId: event.id }, 'outbox routing failed');
    }
  }
  await markOutboxPublished(tx, published);
  return { published, failed };
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
        await relayOutboxEvents(tx, events, opts.log);
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
