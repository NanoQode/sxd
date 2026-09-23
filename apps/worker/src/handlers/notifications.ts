import type { JobRunner } from '../runner';

/**
 * Notification fan-out. Wave 3 wires the mail/SMS adapters; until then the
 * handlers record the intent so nothing is silently dropped.
 */
export function registerNotificationHandlers(runner: JobRunner): void {
  const kinds = [
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
    'notifications.send_due_reminders',
    'notifications.send_digests',
  ];
  for (const kind of kinds) {
    runner.register(kind, async ({ log, job }) => {
      log.info(
        { kind, payloadKeys: Object.keys(job.payload as object) },
        'notification handler placeholder (delivery adapters wired in Wave 3)',
      );
    });
  }
}
