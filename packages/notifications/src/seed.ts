import { notificationTemplates } from '@simplexd/db/seed';
import { schema, systemContext, withActor } from '@simplexd/db';
import type { Db } from './types';

/**
 * Templates consumed by the event registry that the reference seed does not
 * ship. `ensureNotificationTemplates` loads both sets (reference + these) as
 * approved `en` version 1 rows, skipping any key/channel that already exists,
 * so it is safe to run on every deploy and in tests.
 */
export const extraNotificationTemplates: Array<{
  key: string;
  channel: 'email' | 'sms' | 'in_app';
  subject?: string;
  bodyText: string;
  variables: string[];
}> = [
  // In-app counterparts of the seeded email/SMS templates.
  {
    key: 'booking_confirmation',
    channel: 'in_app',
    subject: 'Your {{kind}} is confirmed',
    bodyText:
      '{{startsAtCustomer}} ({{customerTimeZone}}). Manage or reschedule from your bookings.',
    variables: ['kind', 'startsAtCustomer', 'customerTimeZone'],
  },
  {
    key: 'booking_reminder',
    channel: 'in_app',
    subject: 'Reminder: {{kind}} at {{startsAtCustomer}}',
    bodyText: 'Your {{kind}} starts at {{startsAtCustomer}} ({{customerTimeZone}}).',
    variables: ['kind', 'startsAtCustomer', 'customerTimeZone'],
  },
  {
    key: 'visit_change',
    channel: 'in_app',
    subject: 'Your {{kind}} was {{change}}',
    bodyText: 'Open the booking for the latest details.',
    variables: ['kind', 'change'],
  },
  {
    key: 'invoice_due',
    channel: 'in_app',
    subject: 'Invoice {{invoiceNumber}} is due {{dueDate}}',
    bodyText: 'Amount due: {{amount}}.',
    variables: ['invoiceNumber', 'dueDate', 'amount'],
  },
  {
    key: 'report_ready',
    channel: 'in_app',
    subject: 'Report ready: {{reportTitle}}',
    bodyText: 'A new report has been released to your account.',
    variables: ['reportTitle'],
  },
  {
    key: 'urgent_decision',
    channel: 'in_app',
    subject: 'Decision required: {{subject}}',
    bodyText: 'Please respond by {{dueAt}}.',
    variables: ['subject', 'dueAt'],
  },
  {
    key: 'quote_issued',
    channel: 'in_app',
    subject: 'Quote {{reference}} (v{{version}}) is ready',
    bodyText: 'Review and accept the quote from your requests.',
    variables: ['reference', 'version'],
  },
  {
    key: 'payment_receipt',
    channel: 'in_app',
    subject: 'Payment of {{amount}} received',
    bodyText: 'Receipt {{receiptNumber}} for invoice {{invoiceNumber}}.',
    variables: ['amount', 'receiptNumber', 'invoiceNumber'],
  },
  // Events without a reference template.
  {
    key: 'lead_created',
    channel: 'email',
    subject: 'New consultation request from {{contactName}}',
    bodyText:
      'A new lead arrived from {{source}}.\n\nContact: {{contactName}}\nInterest: {{serviceName}}\n\nReview: {{leadUrl}}',
    variables: ['contactName', 'source', 'serviceName', 'leadUrl'],
  },
  {
    key: 'lead_created',
    channel: 'in_app',
    subject: 'New lead: {{contactName}}',
    bodyText: '{{serviceName}} via {{source}}.',
    variables: ['contactName', 'serviceName', 'source'],
  },
  {
    key: 'lead_invited',
    channel: 'email',
    subject: 'Continue your {{serviceName}} request on SimplexD',
    bodyText:
      'Hello {{contactName}},\n\n{{invitedBy}} has opened a workspace for your {{serviceName}} request. Create your account to follow progress, share documents and approve work:\n\n{{inviteUrl}}\n\nSimplexD',
    variables: ['contactName', 'invitedBy', 'serviceName', 'inviteUrl'],
  },
  {
    key: 'engagement_transitioned',
    channel: 'email',
    subject: 'Request {{reference}} is now {{statusLabel}}',
    bodyText:
      'Hello {{name}},\n\nYour request "{{title}}" ({{reference}}) moved to {{statusLabel}}.\n\nView: {{requestUrl}}\n\nSimplexD',
    variables: ['name', 'title', 'reference', 'statusLabel', 'requestUrl'],
  },
  {
    key: 'engagement_transitioned',
    channel: 'in_app',
    subject: 'Request {{reference}} is now {{statusLabel}}',
    bodyText: '{{title}}',
    variables: ['reference', 'statusLabel', 'title'],
  },
  {
    key: 'task_assigned',
    channel: 'in_app',
    subject: 'Task assigned: {{title}}',
    bodyText: 'Open the task to see what is needed.',
    variables: ['title'],
  },
  {
    key: 'task_assigned',
    channel: 'email',
    subject: 'Task assigned: {{title}}',
    bodyText:
      'Hello {{name}},\n\nA task needs your attention: {{title}}.\n\nOpen: {{taskUrl}}\n\nSimplexD',
    variables: ['name', 'title', 'taskUrl'],
  },
  {
    key: 'message_posted',
    channel: 'in_app',
    subject: 'New message in {{subject}}',
    bodyText: 'Open the conversation to read and reply.',
    variables: ['subject'],
  },
  {
    key: 'work_order',
    channel: 'in_app',
    subject: 'Work order {{title}} is {{statusLabel}}',
    bodyText: 'Open the work order for details.',
    variables: ['title', 'statusLabel'],
  },
  {
    key: 'work_order',
    channel: 'email',
    subject: 'Work order {{title}} is {{statusLabel}}',
    bodyText:
      'Hello {{name}},\n\nWork order "{{title}}" is now {{statusLabel}}.\n\nView: {{workOrderUrl}}\n\nSimplexD',
    variables: ['name', 'title', 'statusLabel', 'workOrderUrl'],
  },
  {
    key: 'tender_invitation',
    channel: 'email',
    subject: 'Tender invitation: {{tenderTitle}}',
    bodyText:
      'Hello {{name}},\n\nYou are invited to bid on "{{tenderTitle}}". Submissions close {{deadline}}.\n\nView: {{tenderUrl}}\n\nSimplexD',
    variables: ['name', 'tenderTitle', 'deadline', 'tenderUrl'],
  },
  {
    key: 'tender_invitation',
    channel: 'in_app',
    subject: 'Tender invitation: {{tenderTitle}}',
    bodyText: 'Submissions close {{deadline}}.',
    variables: ['tenderTitle', 'deadline'],
  },
  {
    key: 'award_published',
    channel: 'email',
    subject: 'Award decision: {{tenderTitle}}',
    bodyText:
      'Hello {{name}},\n\nThe award for "{{tenderTitle}}" has been published.\n\nView: {{tenderUrl}}\n\nSimplexD',
    variables: ['name', 'tenderTitle', 'tenderUrl'],
  },
  {
    key: 'award_published',
    channel: 'in_app',
    subject: 'Award decision: {{tenderTitle}}',
    bodyText: 'The award has been published.',
    variables: ['tenderTitle'],
  },
  {
    key: 'project_status_changed',
    channel: 'in_app',
    subject: 'Project {{projectName}} is now {{statusLabel}}',
    bodyText: 'Open the project for the latest timeline and budget.',
    variables: ['projectName', 'statusLabel'],
  },
  {
    key: 'digest',
    channel: 'email',
    subject: 'Your SimplexD {{period}} digest ({{count}} updates)',
    bodyText:
      'Hello {{name}},\n\nHere is what happened since your last digest:\n\n{{items}}\n\nOpen your portal: {{appUrl}}\n\nSimplexD',
    variables: ['name', 'period', 'count', 'items', 'appUrl'],
  },
  {
    key: 'test_message',
    channel: 'in_app',
    subject: 'Test notification ({{environment}})',
    bodyText: 'Sent at {{sentAt}}.',
    variables: ['environment', 'sentAt'],
  },
];

/** Idempotent loader: reference templates plus the registry extras, approved, version 1. */
export async function ensureNotificationTemplates(db: Db): Promise<number> {
  return withActor(db, systemContext('notification-templates'), async (tx) => {
    let inserted = 0;
    for (const t of [...notificationTemplates, ...extraNotificationTemplates]) {
      const rows = await tx
        .insert(schema.templates)
        .values({ ...t, status: 'approved', locale: 'en', version: 1 })
        .onConflictDoNothing()
        .returning({ id: schema.templates.id });
      inserted += rows.length;
    }
    return inserted;
  });
}
