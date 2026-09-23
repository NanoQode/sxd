import { desc, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { schema, systemContext, withActor, type DbExecutor } from '@simplexd/db';
import { dispatchRequest } from './dispatch';
import { resolveEnv, type PipelineEnv } from './env';
import { organizationMemberSpecs, staffWithRoles } from './recipients';
import { resolveOpsAlert } from './ops-alerts';
import { searchPurchaseResolvers } from './search-purchase';
import type {
  Db,
  DispatchResult,
  NotificationCategory,
  NotificationChannel,
  NotificationRequest,
  PipelineOptions,
  RecipientSpec,
  ResolvedRecipient,
} from './types';

/**
 * Event registry: maps outbox event types to template keys, categories,
 * channels and recipient resolution. Unknown event types are logged and
 * ignored so a new business event never crashes the notification queue.
 */

export interface OutboxEventLike {
  id: number | string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  organizationId?: string | null;
  actorUserId?: string | null;
  correlationId?: string | null;
}

interface ResolverContext {
  tx: DbExecutor;
  event: OutboxEventLike;
  payload: Record<string, unknown>;
  env: PipelineEnv;
  scope: string;
}

type EventResolver = (ctx: ResolverContext) => Promise<NotificationRequest[]>;

const CUSTOMER_ROLES = ['owner', 'approver', 'member'];
const ALL: NotificationChannel[] = ['email', 'sms', 'in_app'];
const EMAIL_APP: NotificationChannel[] = ['email', 'in_app'];

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
export const statusLabel = (s: string | null | undefined): string =>
  (s ?? 'updated').replace(/_/g, ' ');

export function formatNaira(kobo: bigint | number | string | null | undefined): string {
  const value = Number(kobo ?? 0) / 100;
  return `₦${value.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatWhen(date: Date | string | null | undefined, zone = 'Africa/Lagos'): string {
  if (!date) return 'to be confirmed';
  const dt = (
    typeof date === 'string' ? DateTime.fromISO(date) : DateTime.fromJSDate(date)
  ).setZone(zone);
  return dt.isValid ? dt.toFormat('ccc d LLL yyyy, HH:mm') : String(date);
}

const requestedNotification: EventResolver = async ({ payload, env, scope, event }) => {
  const templateKey = str(payload['templateKey']) ?? str(payload['kind']);
  if (!templateKey) return [];
  const category = (str(payload['category']) as NotificationCategory | null) ?? 'transactional';
  const channels = (
    strings(payload['channels']).length
      ? strings(payload['channels'])
      : [str(payload['channel']) ?? 'email']
  ) as NotificationChannel[];
  const recipient: RecipientSpec = {
    userId: str(payload['userId']),
    email: str(payload['email']),
    phone: str(payload['phone']) ?? str(payload['phoneE164']),
    name: str(payload['name']),
  };
  const explicit = payload['variables'];
  const variables =
    explicit && typeof explicit === 'object'
      ? (explicit as Record<string, string | number>)
      : Object.fromEntries(
          Object.entries(payload).filter(([, v]) => typeof v === 'string' || typeof v === 'number'),
        );
  // Organisation invitations are also announced by `invitation.created`; share a scope.
  const dedupeScope =
    str(payload['dedupeKey']) ??
    (templateKey === 'invitation' && recipient.email
      ? `invitation:${event.organizationId ?? 'none'}:${recipient.email.toLowerCase()}`
      : scope);
  return [
    {
      templateKey,
      category,
      channels,
      recipients: [recipient],
      variables: { appUrl: env.appUrl, ...variables },
      dedupeScope,
      inApp: {
        title: str(payload['title']) ?? undefined,
        body: str(payload['body']),
        linkPath: str(payload['linkPath']),
      },
      relatedEntity: {
        type: event.aggregateType,
        id: isUuid(event.aggregateId) ? event.aggregateId : null,
      },
      organizationId: event.organizationId ?? null,
      correlationId: event.correlationId ?? null,
    },
  ];
};

const isUuid = (v: string | null | undefined): v is string =>
  typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

async function customerRecipients(
  tx: DbExecutor,
  organizationId: string | null,
  extra: Array<string | null | undefined>,
): Promise<RecipientSpec[]> {
  const specs: RecipientSpec[] = organizationId
    ? await organizationMemberSpecs(tx, organizationId, CUSTOMER_ROLES)
    : [];
  for (const userId of extra) if (userId) specs.push({ userId });
  return specs;
}

/**
 * Generic activity notification for events whose services name the affected
 * users in `recipientUserIds`; staff-facing events add the roles that act on
 * them. Messages carry no amounts beyond what the recipient can already see
 * in their own portal.
 */
function activityUpdate(opts: {
  title: (p: Record<string, unknown>) => string;
  message: (p: Record<string, unknown>) => string;
  link: (p: Record<string, unknown>, event: OutboxEventLike) => string;
  channels?: NotificationChannel[];
  category?: NotificationCategory;
  staffRoles?: Array<(typeof schema.staffRoleEnum.enumValues)[number]>;
  /** Also notify the customer organisation named on the event. */
  organizationMembers?: boolean;
  entityType: string;
}): EventResolver {
  return async ({ tx, event, payload, env, scope }) => {
    const recipients: RecipientSpec[] = strings(payload['recipientUserIds']).map((userId) => ({
      userId,
    }));
    if (opts.organizationMembers && event.organizationId) {
      recipients.push(...(await customerRecipients(tx, event.organizationId, [])));
    }
    if (opts.staffRoles) recipients.push(...(await staffWithRoles(tx, opts.staffRoles)));
    const seen = new Set<string>();
    const unique = recipients.filter((r) => {
      const key = r.userId ?? r.email ?? '';
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unique.length === 0) return [];
    const linkPath = opts.link(payload, event);
    return [
      {
        templateKey: 'activity_update',
        category: opts.category ?? 'transactional',
        channels: opts.channels ?? EMAIL_APP,
        recipients: unique,
        variables: {
          title: opts.title(payload),
          message: opts.message(payload),
          linkUrl: `${env.appUrl}${linkPath}`,
        },
        dedupeScope: scope,
        inApp: { linkPath },
        relatedEntity: {
          type: opts.entityType,
          id: isUuid(event.aggregateId) ? event.aggregateId : null,
        },
        organizationId: event.organizationId ?? null,
        correlationId: event.correlationId ?? null,
      },
    ];
  };
}

const rentalResolvers: Record<string, EventResolver> = {
  'tenant.invited': async ({ event, payload, env, scope }) => {
    const email = str(payload['email']);
    const link = str(payload['invitationLink']);
    if (!email || !link) return [];
    return [
      {
        templateKey: 'tenant_invitation',
        category: 'transactional',
        channels: ['email'],
        recipients: [{ email, name: str(payload['name']) }],
        variables: {
          name: str(payload['name']) ?? 'there',
          inviteUrl: `${env.appUrl}${link}`,
          expiresAt: formatWhen(str(payload['expiresAt'])),
        },
        dedupeScope: scope,
        relatedEntity: {
          type: 'lease_party',
          id: isUuid(event.aggregateId) ? event.aggregateId : null,
        },
        correlationId: event.correlationId ?? null,
      },
    ];
  },
  'lease.transitioned': activityUpdate({
    entityType: 'lease',
    title: (p) => `Lease ${statusLabel(str(p['to']))}`,
    message: (p) => `Your lease is now ${statusLabel(str(p['to']))}.`,
    link: (p, e) => `/tenant/lease/${str(p['leaseId']) ?? e.aggregateId}`,
  }),
  'lease.renewed': activityUpdate({
    entityType: 'lease',
    title: () => 'Lease renewed',
    message: () => 'A renewal of your lease has been recorded. Review the new term and schedule.',
    link: (p, e) => `/tenant/lease/${str(p['renewalLeaseId']) ?? e.aggregateId}`,
  }),
  'rent.invoice_issued': activityUpdate({
    entityType: 'lease',
    title: () => 'Rent invoice issued',
    message: () =>
      'A new rent invoice is ready. View the amount due and pay from your tenant page.',
    link: () => '/tenant/balances',
    channels: ALL,
  }),
  'rent.overdue': activityUpdate({
    entityType: 'lease',
    title: () => 'Rent overdue',
    message: () =>
      'A rent charge on your lease is past its due date. Please pay or contact the property manager.',
    link: () => '/tenant/balances',
    channels: ALL,
  }),
  'tenant.notice': activityUpdate({
    entityType: 'lease',
    title: (p) => str(p['title']) ?? 'Notice from your property manager',
    message: (p) => str(p['body']) ?? 'Open your tenant page to read the notice.',
    link: () => '/tenant/notices',
  }),
  'owner_statement.issued': activityUpdate({
    entityType: 'owner_statement',
    title: () => 'Owner statement issued',
    message: () => 'Your property statement for the period is ready to review.',
    link: (p, e) => `/portal/properties/statements/${str(p['statementId']) ?? e.aggregateId}`,
  }),
  'payout.transitioned': activityUpdate({
    entityType: 'payout',
    title: (p) => `Owner payout ${statusLabel(str(p['to']))}`,
    message: (p) =>
      `An owner payout moved from ${statusLabel(str(p['from']))} to ${statusLabel(str(p['to']))}.`,
    link: (p, e) => `/admin/rentals/payouts/${str(p['payoutId']) ?? e.aggregateId}`,
    channels: ['in_app'],
    staffRoles: ['finance'],
  }),
  'work_order.sla_breached': activityUpdate({
    entityType: 'work_order',
    title: (p) => `Work order SLA breached (${statusLabel(str(p['priority']))} priority)`,
    message: (p) =>
      `A ${statusLabel(str(p['priority']))}-priority work order passed its SLA while ${statusLabel(str(p['status']))}.`,
    link: (p, e) => `/admin/rentals/work-orders/${str(p['workOrderId']) ?? e.aggregateId}`,
    staffRoles: ['operations_manager'],
  }),
};

/**
 * Finance events: the customer organisation's members and the invoice's
 * addressee (a tenant paying rent is not a member) hear about their invoice;
 * events finance must act on also go to finance staff.
 */
function invoiceUpdate(opts: {
  title: (p: Record<string, unknown>) => string;
  message: (p: Record<string, unknown>) => string;
  staffRoles?: Array<(typeof schema.staffRoleEnum.enumValues)[number]>;
  notifyCustomer?: boolean;
  channels?: NotificationChannel[];
}): EventResolver {
  return async ({ tx, event, payload, env, scope }) => {
    const invoiceId = str(payload['invoiceId']);
    const [invoice] = invoiceId
      ? await tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId))
      : [];
    const requests: NotificationRequest[] = [];
    const customerLink = invoice
      ? invoice.isRentOnBehalfOfOwner
        ? '/tenant/balances'
        : `/portal/invoices/${invoice.id}`
      : '/portal/invoices';
    if (opts.notifyCustomer !== false) {
      const organizationId = invoice?.organizationId ?? event.organizationId ?? null;
      const recipients = invoice?.isRentOnBehalfOfOwner
        ? invoice.customerUserId
          ? [{ userId: invoice.customerUserId }]
          : []
        : await customerRecipients(tx, organizationId, [invoice?.customerUserId]);
      if (recipients.length > 0) {
        requests.push({
          templateKey: 'activity_update',
          category: 'transactional',
          channels: opts.channels ?? EMAIL_APP,
          recipients,
          variables: {
            title: opts.title(payload),
            message: opts.message(payload),
            linkUrl: `${env.appUrl}${customerLink}`,
          },
          dedupeScope: `${scope}:customer`,
          inApp: { linkPath: customerLink },
          relatedEntity: { type: 'invoice', id: invoice?.id ?? null },
          organizationId,
          correlationId: event.correlationId ?? null,
        });
      }
    }
    if (opts.staffRoles) {
      const staff = await staffWithRoles(tx, opts.staffRoles);
      const staffLink = invoice ? `/admin/finance/invoices/${invoice.id}` : '/admin/finance';
      if (staff.length > 0) {
        requests.push({
          templateKey: 'activity_update',
          category: 'transactional',
          channels: ['in_app'],
          recipients: staff,
          variables: {
            title: opts.title(payload),
            message: opts.message(payload),
            linkUrl: `${env.appUrl}${staffLink}`,
          },
          dedupeScope: `${scope}:staff`,
          inApp: { linkPath: staffLink },
          relatedEntity: { type: 'invoice', id: invoice?.id ?? null },
          organizationId: invoice?.organizationId ?? event.organizationId ?? null,
          correlationId: event.correlationId ?? null,
        });
      }
    }
    return requests;
  };
}

const quoteLink = (p: Record<string, unknown>) =>
  str(p['serviceRequestId'])
    ? `/portal/requests/${str(p['serviceRequestId'])}`
    : `/portal/requests`;

const financeResolvers: Record<string, EventResolver> = {
  'quote.accepted': activityUpdate({
    entityType: 'quote',
    title: () => 'Quote accepted',
    message: () => 'A quote was accepted. The next step (invoice or scheduling) is under way.',
    link: (p) =>
      str(p['serviceRequestId'])
        ? `/admin/service-requests/${str(p['serviceRequestId'])}`
        : '/admin/service-requests',
    channels: ['in_app'],
    staffRoles: ['operations_manager', 'project_manager'],
  }),
  'quote.expired': activityUpdate({
    entityType: 'quote',
    organizationMembers: true,
    title: () => 'Quote expired',
    message: () =>
      'A quote passed its validity date without acceptance. Ask for a new one if you still need the service.',
    link: quoteLink,
    staffRoles: ['operations_manager'],
  }),
  'invoice.paid': invoiceUpdate({
    title: () => 'Invoice paid',
    message: () =>
      'Your payment was verified and applied. The receipt is available with the invoice.',
  }),
  'invoice.partially_paid': invoiceUpdate({
    title: () => 'Part payment received',
    message: () => 'A payment was verified and applied; a balance remains on the invoice.',
  }),
  'invoice.voided': invoiceUpdate({
    title: (p) => `Invoice ${str(p['number']) ?? ''} voided`.replace('  ', ' '),
    message: (p) =>
      `The invoice was voided${str(p['reason']) ? `: ${str(p['reason'])}` : ''}. Nothing is owed on it.`,
  }),
  'payment.reversed': invoiceUpdate({
    title: () => 'Payment reversed',
    message: () =>
      'The payment provider reported a reversal, so the payment no longer counts towards the invoice. SimplexD finance will contact you.',
    staffRoles: ['finance'],
  }),
  'bank_transfer.declared': invoiceUpdate({
    title: () => 'Bank transfer to confirm',
    message: () => 'A customer declared a bank transfer. Confirm it against the bank statement.',
    notifyCustomer: false,
    staffRoles: ['finance'],
  }),
  'bank_transfer.rejected': invoiceUpdate({
    title: () => 'Bank transfer not confirmed',
    message: (p) =>
      `The declared transfer could not be matched to a payment${str(p['note']) ? `: ${str(p['note'])}` : ''}.`,
  }),
  'refund.requested': invoiceUpdate({
    title: () => 'Refund requested',
    message: () => 'A refund was requested and needs approval by a different finance user.',
    notifyCustomer: false,
    staffRoles: ['finance'],
  }),
  'refund.settled': invoiceUpdate({
    title: () => 'Refund completed',
    message: () =>
      'The payment provider confirmed the refund. It may take a few days to reach your account.',
  }),
  'refund.failed': invoiceUpdate({
    title: () => 'Refund failed',
    message: () =>
      'The refund could not be completed by the payment provider. SimplexD finance is following up.',
    staffRoles: ['finance'],
  }),
  'credit_note.issued': invoiceUpdate({
    title: () => 'Credit note issued',
    message: () => 'A credit note was issued against your invoice and reduces the amount owed.',
  }),
  'chargeback.opened': invoiceUpdate({
    title: () => 'Chargeback opened',
    message: () =>
      'The card issuer opened a dispute on a payment. Evidence is due by the provider deadline.',
    notifyCustomer: false,
    staffRoles: ['finance'],
  }),
  'integration.degraded': activityUpdate({
    entityType: 'integration',
    title: (p) => `${str(p['provider']) ?? 'An integration'} needs attention`,
    message: (p) =>
      `The scheduled health check failed${str(p['message']) ? `: ${str(p['message'])}` : ''}. Open Integrations to test and fix it.`,
    link: (p) =>
      str(p['provider']) ? `/admin/integrations/${str(p['provider'])}` : '/admin/integrations',
    channels: ['in_app'],
    staffRoles: ['super_admin'],
  }),
};

const tenderLink = (p: Record<string, unknown>, e: OutboxEventLike) =>
  `/partner/tenders/${str(p['tenderId']) ?? e.aggregateId}`;
const tenderAdminLink = (p: Record<string, unknown>, e: OutboxEventLike) =>
  `/admin/tenders/${str(p['tenderId']) ?? e.aggregateId}`;
const rfqPartnerLink = (p: Record<string, unknown>, e: OutboxEventLike) =>
  `/partner/rfqs/${str(p['rfqId']) ?? e.aggregateId}`;
const poPartnerLink = (p: Record<string, unknown>, e: OutboxEventLike) =>
  `/partner/orders/${str(p['purchaseOrderId']) ?? e.aggregateId}`;

const commercialResolvers: Record<string, EventResolver> = {
  'tender.invitation.sent': activityUpdate({
    entityType: 'tender',
    title: () => 'Invitation to tender',
    message: () =>
      'You have been invited to bid. Review the scope, timeline and submission deadline.',
    link: tenderLink,
  }),
  'tender.revised': activityUpdate({
    entityType: 'tender',
    title: () => 'Tender updated',
    message: () =>
      'An addendum was issued for a tender you were invited to. Check what changed before you submit.',
    link: tenderLink,
  }),
  'tender.question.asked': activityUpdate({
    entityType: 'tender',
    title: () => 'New tender question',
    message: () =>
      'A bidder asked a clarification question. Answer and publish it to all invitees.',
    link: tenderAdminLink,
    channels: ['in_app'],
    staffRoles: ['operations_manager'],
  }),
  'tender.question.answered': activityUpdate({
    entityType: 'tender',
    title: () => 'Clarification published',
    message: () => 'A clarification was published for a tender you were invited to.',
    link: tenderLink,
  }),
  'tender.closed': activityUpdate({
    entityType: 'tender',
    title: () => 'Tender closed',
    message: () => 'The submission deadline passed. Bids can now be opened for evaluation.',
    link: tenderAdminLink,
    channels: ['in_app'],
    staffRoles: ['operations_manager'],
  }),
  'tender.bids_opened': activityUpdate({
    entityType: 'tender',
    title: () => 'Sealed bids opened',
    message: () => 'The sealed bids were opened for evaluation. Every read is logged.',
    link: tenderAdminLink,
    channels: ['in_app'],
    staffRoles: ['operations_manager'],
  }),
  'tender.cancelled': activityUpdate({
    entityType: 'tender',
    title: () => 'Tender cancelled',
    message: () =>
      'A tender you were invited to was cancelled. No further submissions are accepted.',
    link: tenderLink,
  }),
  'tender.award.published': activityUpdate({
    entityType: 'tender',
    title: () => 'Tender result published',
    message: () => 'The result of a tender you bid on was published. Open it to see your outcome.',
    link: tenderLink,
  }),
  'tender.award.responded': activityUpdate({
    entityType: 'tender',
    title: (p) =>
      `Award ${str(p['decision']) === 'declined' ? 'declined' : 'accepted'} by the contractor`,
    message: () => 'The winning contractor responded to the award.',
    link: tenderAdminLink,
    channels: ['in_app'],
    staffRoles: ['operations_manager'],
  }),
  'bid.submitted': activityUpdate({
    entityType: 'bid',
    title: () => 'Bid received',
    message: () => 'A sealed bid was submitted. Its contents stay sealed until the tender closes.',
    link: tenderAdminLink,
    channels: ['in_app'],
    staffRoles: ['operations_manager'],
  }),
  'rfq.issued': activityUpdate({
    entityType: 'rfq',
    title: () => 'Request for quotation',
    message: () => 'You have been asked to quote for materials. Respond before the deadline.',
    link: rfqPartnerLink,
  }),
  'rfq.response.submitted': activityUpdate({
    entityType: 'rfq',
    title: () => 'Quotation received',
    message: () => 'A supplier responded to a request for quotation.',
    link: (p, e) => `/admin/procurement/rfqs/${str(p['rfqId']) ?? e.aggregateId}`,
    channels: ['in_app'],
    staffRoles: ['operations_manager'],
  }),
  'purchase_order.issued': activityUpdate({
    entityType: 'purchase_order',
    title: () => 'Purchase order issued',
    message: () =>
      'A purchase order was issued to you. Acknowledge it and confirm the delivery date.',
    link: poPartnerLink,
  }),
  'purchase_order.cancelled': activityUpdate({
    entityType: 'purchase_order',
    title: () => 'Purchase order cancelled',
    message: () => 'A purchase order you received was cancelled.',
    link: poPartnerLink,
  }),
  'delivery.recorded': activityUpdate({
    entityType: 'purchase_order',
    title: () => 'Delivery recorded',
    message: () => 'A delivery against your purchase order was recorded.',
    link: poPartnerLink,
  }),
  'delivery.discrepancy.opened': activityUpdate({
    entityType: 'purchase_order',
    title: () => 'Delivery discrepancy',
    message: () =>
      'A discrepancy was recorded on a delivery (quantity, damage or specification). Please review it.',
    link: poPartnerLink,
  }),
};

const resolvers: Record<string, EventResolver> = {
  ...rentalResolvers,
  ...financeResolvers,
  ...commercialResolvers,
  ...searchPurchaseResolvers,
  'notification.requested': requestedNotification,
  // Monitoring thresholds (apps/worker/src/monitoring); staff roles named on the event.
  'ops.alert': resolveOpsAlert,

  'lead.created': async ({ tx, event, payload, env, scope }) => {
    const leadId = str(payload['leadId']) ?? event.aggregateId;
    const [lead] = await tx.select().from(schema.leads).where(eq(schema.leads.id, leadId));
    if (!lead) return [];
    const [service] = lead.interestServiceId
      ? await tx
          .select({ name: schema.services.name })
          .from(schema.services)
          .where(eq(schema.services.id, lead.interestServiceId))
      : [];
    const staff = await staffWithRoles(tx, ['operations_manager', 'super_admin']);
    if (staff.length === 0) return [];
    return [
      {
        templateKey: 'lead_created',
        category: 'transactional',
        channels: EMAIL_APP,
        recipients: staff,
        variables: {
          contactName: lead.contactName,
          source: statusLabel(lead.source),
          serviceName: service?.name ?? 'General enquiry',
          leadUrl: `${env.appUrl}/admin/leads/${lead.id}`,
        },
        dedupeScope: scope,
        inApp: { linkPath: `/admin/leads/${lead.id}` },
        relatedEntity: { type: 'lead', id: lead.id },
        correlationId: event.correlationId ?? null,
      },
    ];
  },

  'lead.invited': async ({ event, payload, scope }) => {
    const email = str(payload['email']);
    if (!email) return [];
    return [
      {
        templateKey: 'lead_invited',
        category: 'transactional',
        channels: ['email'],
        recipients: [{ email, name: str(payload['contactName']) }],
        variables: {
          contactName: str(payload['contactName']) ?? 'there',
          invitedBy: str(payload['invitedBy']) ?? 'SimplexD',
          serviceName: str(payload['serviceName']) ?? 'service',
          inviteUrl: str(payload['inviteUrl']) ?? '',
        },
        dedupeScope: scope,
        relatedEntity: { type: 'lead', id: isUuid(event.aggregateId) ? event.aggregateId : null },
        correlationId: event.correlationId ?? null,
      },
    ];
  },

  'service_request.transitioned': async ({ tx, event, payload, env, scope }) => {
    const id = str(payload['serviceRequestId']) ?? event.aggregateId;
    const [sr] = await tx
      .select()
      .from(schema.serviceRequests)
      .where(eq(schema.serviceRequests.id, id));
    if (!sr) return [];
    const to = str(payload['to']) ?? sr.status;
    const recipients: RecipientSpec[] = [{ userId: sr.requestedByUserId }];
    if (sr.assignedPmUserId && sr.assignedPmUserId !== event.actorUserId) {
      recipients.push({ userId: sr.assignedPmUserId });
    }
    return [
      {
        templateKey: 'engagement_transitioned',
        category: 'transactional',
        channels: EMAIL_APP,
        recipients,
        variables: (r: ResolvedRecipient) => ({
          name: r.name,
          title: sr.title,
          reference: sr.reference,
          statusLabel: statusLabel(to),
          requestUrl: `${env.appUrl}/portal/requests/${sr.id}`,
        }),
        dedupeScope: scope,
        inApp: { linkPath: `/portal/requests/${sr.id}` },
        relatedEntity: { type: 'service_request', id: sr.id },
        organizationId: sr.organizationId,
        correlationId: event.correlationId ?? null,
      },
    ];
  },

  'invitation.created': async ({ tx, event, payload, env }) => {
    const [invite] = await tx
      .select()
      .from(schema.invitation)
      .where(eq(schema.invitation.id, event.aggregateId));
    const email = (str(payload['email']) ?? invite?.email ?? '').toLowerCase();
    if (!email || !invite) return [];
    const [org] = await tx
      .select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, invite.organizationId));
    const [inviter] = await tx
      .select({ name: schema.user.name })
      .from(schema.user)
      .where(eq(schema.user.id, invite.inviterId));
    return [
      {
        templateKey: 'invitation',
        category: 'transactional',
        channels: ['email'],
        recipients: [{ email }],
        variables: {
          inviterName: inviter?.name ?? 'A team member',
          organizationName: org?.name ?? 'an organisation',
          role: invite.role ?? 'member',
          inviteUrl: `${env.appUrl}/invitations/${invite.id}`,
          expiresAt: formatWhen(invite.expiresAt),
        },
        dedupeScope: `invitation:${invite.organizationId}:${email}`,
        relatedEntity: { type: 'invitation', id: null },
        organizationId: invite.organizationId,
        correlationId: event.correlationId ?? null,
      },
    ];
  },

  'quote.issued': async ({ tx, event, payload, env, scope }) => {
    const quoteId = str(payload['quoteId']) ?? event.aggregateId;
    const [quote] = await tx.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId));
    if (!quote) return [];
    const [sr] = await tx
      .select()
      .from(schema.serviceRequests)
      .where(eq(schema.serviceRequests.id, quote.serviceRequestId));
    if (!sr) return [];
    return [
      {
        templateKey: 'quote_issued',
        category: 'transactional',
        channels: EMAIL_APP,
        recipients: await customerRecipients(tx, sr.organizationId, [sr.requestedByUserId]),
        variables: (r: ResolvedRecipient) => ({
          name: r.name,
          reference: sr.reference,
          version: Number(payload['version'] ?? quote.currentVersion),
          quoteUrl: `${env.appUrl}/portal/requests/${sr.id}#quote`,
        }),
        dedupeScope: scope,
        inApp: { linkPath: `/portal/requests/${sr.id}#quote` },
        relatedEntity: { type: 'quote', id: quote.id },
        organizationId: sr.organizationId,
        correlationId: event.correlationId ?? null,
      },
    ];
  },

  'invoice.issued': async ({ tx, event, payload, env, scope }) => {
    const invoiceId = str(payload['invoiceId']) ?? event.aggregateId;
    const [invoice] = await tx
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, invoiceId));
    if (!invoice) return [];
    return [
      {
        templateKey: 'invoice_due',
        category: 'transactional',
        channels: ALL,
        recipients: await customerRecipients(tx, invoice.organizationId, [invoice.customerUserId]),
        variables: (r: ResolvedRecipient) => ({
          name: r.name,
          invoiceNumber: invoice.number,
          amount: formatNaira(invoice.totalKobo),
          dueDate: invoice.dueDate ?? 'on receipt',
          invoiceUrl: `${env.appUrl}/portal/invoices/${invoice.id}`,
        }),
        dedupeScope: scope,
        inApp: { linkPath: `/portal/invoices/${invoice.id}` },
        relatedEntity: { type: 'invoice', id: invoice.id },
        organizationId: invoice.organizationId,
        correlationId: event.correlationId ?? null,
      },
    ];
  },

  'payment.verified': async ({ tx, event, payload, env, scope }) => {
    const invoiceId = str(payload['invoiceId']);
    if (!invoiceId) return [];
    const [invoice] = await tx
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, invoiceId));
    if (!invoice) return [];
    const [receipt] = await tx
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.invoiceId, invoice.id))
      .orderBy(desc(schema.receipts.issuedAt))
      .limit(1);
    const amount = payload['amountKobo'] ?? receipt?.amountKobo ?? invoice.amountPaidKobo;
    return [
      {
        templateKey: 'payment_receipt',
        category: 'transactional',
        channels: EMAIL_APP,
        recipients: await customerRecipients(tx, invoice.organizationId, [invoice.customerUserId]),
        variables: (r: ResolvedRecipient) => ({
          name: r.name,
          amount: formatNaira(amount as bigint | number | string),
          invoiceNumber: invoice.number,
          receiptNumber: str(payload['receiptNumber']) ?? receipt?.number ?? 'pending',
          receiptUrl: `${env.appUrl}/portal/invoices/${invoice.id}#receipts`,
        }),
        dedupeScope: scope,
        inApp: { linkPath: `/portal/invoices/${invoice.id}#receipts` },
        relatedEntity: { type: 'invoice', id: invoice.id },
        organizationId: invoice.organizationId,
        correlationId: event.correlationId ?? null,
      },
    ];
  },

  'appointment.booked': (ctx) => appointmentRequest(ctx, 'booking_confirmation', null),
  'appointment.confirmed': (ctx) => appointmentRequest(ctx, 'booking_confirmation', null),
  'appointment.rescheduled': (ctx) => appointmentRequest(ctx, 'visit_change', 'rescheduled'),
  'appointment.cancelled': (ctx) => appointmentRequest(ctx, 'visit_change', 'cancelled'),
  'appointment.reminder_due': (ctx) =>
    appointmentRequest(ctx, 'booking_reminder', null, 'reminders'),

  'appointment.sync_conflict': async ({ tx, event, payload, env, scope }) => {
    const id = str(payload['appointmentId']) ?? event.aggregateId;
    const [appt] = await tx
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, id));
    if (!appt) return [];
    const staffUserId = str(payload['staffUserId']) ?? appt.staffUserId;
    return [
      {
        templateKey: 'urgent_decision',
        category: 'transactional',
        channels: EMAIL_APP,
        recipients: [{ userId: staffUserId }],
        variables: (r: ResolvedRecipient) => ({
          name: r.name,
          subject: `Calendar conflict for ${statusLabel(appt.kind)} at ${formatWhen(appt.startsAt, appt.businessTimeZone)}${str(payload['reason']) ? ` (${str(payload['reason'])})` : ''}`,
          dueAt: 'as soon as possible',
          decisionUrl: `${env.appUrl}/admin/bookings/${appt.id}`,
        }),
        dedupeScope: scope,
        inApp: { linkPath: `/admin/bookings/${appt.id}` },
        relatedEntity: { type: 'appointment', id: appt.id },
        organizationId: appt.organizationId,
        correlationId: event.correlationId ?? null,
      },
    ];
  },

  'report.released': (ctx) => reportRequest(ctx),
  'project.report.released': (ctx) => reportRequest(ctx),

  'change_order.submitted': async ({ tx, event, payload, env, scope }) => {
    const id = str(payload['changeOrderId']) ?? event.aggregateId;
    const [co] = await tx.select().from(schema.changeOrders).where(eq(schema.changeOrders.id, id));
    if (!co) return [];
    const [project] = await tx
      .select({ customerContactUserId: schema.projects.customerContactUserId })
      .from(schema.projects)
      .where(eq(schema.projects.id, co.projectId));
    const dueAt = str(payload['dueAt']);
    return [
      {
        templateKey: 'urgent_decision',
        category: 'transactional',
        channels: ALL,
        recipients: await customerRecipients(tx, co.organizationId, [
          project?.customerContactUserId,
        ]),
        variables: (r: ResolvedRecipient) => ({
          name: r.name,
          subject: `Change order #${co.number}: ${co.title}`,
          dueAt: dueAt ? formatWhen(dueAt) : 'as soon as possible',
          decisionUrl: `${env.appUrl}/portal/projects/${co.projectId}/change-orders/${co.id}`,
        }),
        dedupeScope: scope,
        inApp: { linkPath: `/portal/projects/${co.projectId}/change-orders/${co.id}` },
        relatedEntity: { type: 'change_order', id: co.id },
        organizationId: co.organizationId,
        correlationId: event.correlationId ?? null,
      },
    ];
  },

  'tender.published': async ({ tx, event, payload, env, scope }) => {
    const id = str(payload['tenderId']) ?? event.aggregateId;
    const [tender] = await tx.select().from(schema.tenders).where(eq(schema.tenders.id, id));
    if (!tender) return [];
    const recipients = strings(payload['recipientUserIds']).map((userId) => ({ userId }));
    if (recipients.length === 0) return [];
    return [
      {
        templateKey: 'tender_invitation',
        category: 'transactional',
        channels: EMAIL_APP,
        recipients,
        variables: (r: ResolvedRecipient) => ({
          name: r.name,
          tenderTitle: tender.title,
          deadline: formatWhen(tender.submissionDeadlineAt, tender.displayTimeZone),
          tenderUrl: `${env.appUrl}/partners/tenders/${tender.id}`,
        }),
        dedupeScope: scope,
        inApp: { linkPath: `/partners/tenders/${tender.id}` },
        relatedEntity: { type: 'tender', id: tender.id },
        organizationId: tender.organizationId,
        correlationId: event.correlationId ?? null,
      },
    ];
  },

  'award.published': async ({ tx, event, payload, env, scope }) => {
    const tenderId = str(payload['tenderId']);
    const [award] = tenderId
      ? await tx.select().from(schema.awards).where(eq(schema.awards.tenderId, tenderId))
      : await tx.select().from(schema.awards).where(eq(schema.awards.id, event.aggregateId));
    if (!award) return [];
    const [tender] = await tx
      .select()
      .from(schema.tenders)
      .where(eq(schema.tenders.id, award.tenderId));
    if (!tender) return [];
    const recipients = [
      ...strings(payload['recipientUserIds']).map((userId) => ({ userId })),
      ...(await customerRecipients(tx, tender.organizationId, [])),
    ];
    return [
      {
        templateKey: 'award_published',
        category: 'transactional',
        channels: EMAIL_APP,
        recipients,
        variables: (r: ResolvedRecipient) => ({
          name: r.name,
          tenderTitle: tender.title,
          tenderUrl: `${env.appUrl}/portal/tenders/${tender.id}`,
        }),
        dedupeScope: scope,
        inApp: { linkPath: `/portal/tenders/${tender.id}` },
        relatedEntity: { type: 'tender', id: tender.id },
        organizationId: tender.organizationId,
        correlationId: event.correlationId ?? null,
      },
    ];
  },

  'work_order.transitioned': async ({ tx, event, payload, env, scope }) => {
    const id = str(payload['workOrderId']) ?? event.aggregateId;
    const [wo] = await tx.select().from(schema.workOrders).where(eq(schema.workOrders.id, id));
    if (!wo) return [];
    const recipients: RecipientSpec[] = [];
    for (const userId of [wo.reportedByUserId, wo.assigneeUserId]) {
      if (userId && userId !== event.actorUserId) recipients.push({ userId });
    }
    const to = str(payload['to']) ?? wo.status;
    return [
      {
        templateKey: 'work_order',
        category: 'transactional',
        channels: EMAIL_APP,
        recipients,
        variables: (r: ResolvedRecipient) => ({
          name: r.name,
          title: wo.title,
          statusLabel: statusLabel(to),
          workOrderUrl: `${env.appUrl}/portal/work-orders/${wo.id}`,
        }),
        dedupeScope: scope,
        inApp: { linkPath: `/portal/work-orders/${wo.id}` },
        relatedEntity: { type: 'work_order', id: wo.id },
        organizationId: wo.organizationId,
        correlationId: event.correlationId ?? null,
      },
    ];
  },

  'task.assigned': async ({ tx, event, payload, env, scope }) => {
    const id = str(payload['taskId']) ?? event.aggregateId;
    const [task] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, id));
    if (!task) return [];
    const ids = strings(payload['recipientUserIds']);
    if (task.assigneeUserId && !ids.includes(task.assigneeUserId)) ids.push(task.assigneeUserId);
    const recipients = ids.filter((u) => u !== event.actorUserId).map((userId) => ({ userId }));
    if (recipients.length === 0) return [];
    const linkPath = task.serviceRequestId
      ? `/portal/requests/${task.serviceRequestId}#tasks`
      : task.projectId
        ? `/portal/projects/${task.projectId}#tasks`
        : '/portal/tasks';
    return [
      {
        templateKey: 'task_assigned',
        category: 'transactional',
        channels: EMAIL_APP,
        recipients,
        variables: (r: ResolvedRecipient) => ({
          name: r.name,
          title: task.title,
          taskUrl: `${env.appUrl}${linkPath}`,
        }),
        dedupeScope: scope,
        inApp: { linkPath },
        relatedEntity: { type: 'task', id: task.id },
        organizationId: task.organizationId,
        correlationId: event.correlationId ?? null,
      },
    ];
  },

  'message.posted': async ({ tx, event, payload, scope }) => {
    const conversationId = str(payload['conversationId']) ?? event.aggregateId;
    const [conversation] = await tx
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId));
    if (!conversation) return [];
    const recipients = strings(payload['recipientUserIds'])
      .filter((u) => u !== (str(payload['senderUserId']) ?? event.actorUserId))
      .map((userId) => ({ userId }));
    if (recipients.length === 0) return [];
    return [
      {
        templateKey: 'message_posted',
        category: 'transactional',
        channels: ['in_app'],
        recipients,
        variables: { subject: conversation.subject },
        dedupeScope: scope,
        inApp: { linkPath: `/portal/messages/${conversation.id}` },
        relatedEntity: { type: 'conversation', id: conversation.id },
        organizationId: conversation.organizationId,
        correlationId: event.correlationId ?? null,
      },
    ];
  },

  'project.status_changed': async ({ tx, event, payload, scope }) => {
    const id = str(payload['projectId']) ?? event.aggregateId;
    const [project] = await tx.select().from(schema.projects).where(eq(schema.projects.id, id));
    if (!project) return [];
    return [
      {
        templateKey: 'project_status_changed',
        category: 'transactional',
        channels: ['in_app'],
        recipients: await customerRecipients(tx, project.organizationId, [
          project.customerContactUserId,
        ]),
        variables: {
          projectName: project.name,
          statusLabel: statusLabel(str(payload['to']) ?? project.status),
        },
        dedupeScope: scope,
        inApp: { linkPath: `/portal/projects/${project.id}` },
        relatedEntity: { type: 'project', id: project.id },
        organizationId: project.organizationId,
        correlationId: event.correlationId ?? null,
      },
    ];
  },

  'setup_token.issued': async ({ event, payload, scope }) => {
    const email = str(payload['email']);
    const setupUrl = str(payload['setupUrl']);
    if (!email || !setupUrl) return [];
    return [
      {
        templateKey: 'admin_setup',
        category: 'security',
        channels: ['email'],
        recipients: [{ email }],
        variables: { setupUrl, expiresAt: formatWhen(str(payload['expiresAt'])) },
        dedupeScope: scope,
        relatedEntity: { type: 'setup_token', id: null },
        correlationId: event.correlationId ?? null,
      },
    ];
  },
};

// Aliases used by other modules' event names.
resolvers['engagement.transitioned'] = resolvers['service_request.transitioned']!;
resolvers['payment.settled'] = resolvers['payment.verified']!;

async function appointmentRequest(
  { tx, event, payload, env, scope }: ResolverContext,
  templateKey: string,
  change: string | null,
  category: NotificationCategory = 'transactional',
): Promise<NotificationRequest[]> {
  const id = str(payload['appointmentId']) ?? event.aggregateId;
  const [appt] = await tx.select().from(schema.appointments).where(eq(schema.appointments.id, id));
  if (!appt) return [];
  const recipient: RecipientSpec = appt.customerUserId
    ? { userId: appt.customerUserId, timeZone: appt.customerTimeZone }
    : {
        email: appt.guestEmail,
        phone: appt.guestPhoneE164,
        name: appt.guestName,
        timeZone: appt.customerTimeZone,
      };
  const manageUrl = `${env.appUrl}/bookings/${appt.manageToken ?? appt.id}`;
  return [
    {
      templateKey,
      category,
      channels: ALL,
      recipients: [recipient],
      variables: (r: ResolvedRecipient) => ({
        name: r.name,
        kind: statusLabel(appt.kind),
        change: change ?? statusLabel(appt.status),
        startsAtCustomer: formatWhen(appt.startsAt, appt.customerTimeZone),
        customerTimeZone: appt.customerTimeZone,
        startsAtBusiness: formatWhen(appt.startsAt, appt.businessTimeZone),
        businessTimeZone: appt.businessTimeZone,
        manageUrl,
      }),
      dedupeScope: scope,
      inApp: { linkPath: `/portal/bookings/${appt.id}` },
      relatedEntity: { type: 'appointment', id: appt.id },
      organizationId: appt.organizationId,
      correlationId: event.correlationId ?? null,
    },
  ];
}

async function reportRequest({
  tx,
  event,
  payload,
  env,
  scope,
}: ResolverContext): Promise<NotificationRequest[]> {
  const id = str(payload['reportId']) ?? event.aggregateId;
  const [report] = await tx.select().from(schema.reports).where(eq(schema.reports.id, id));
  if (!report || !report.customerVisible) return [];
  const [project] = report.projectId
    ? await tx
        .select({ customerContactUserId: schema.projects.customerContactUserId })
        .from(schema.projects)
        .where(eq(schema.projects.id, report.projectId))
    : [];
  const reportUrl = `${env.appUrl}/portal/reports/${report.id}`;
  return [
    {
      templateKey: 'report_ready',
      category: 'transactional',
      channels: ALL,
      recipients: await customerRecipients(tx, report.organizationId, [
        project?.customerContactUserId,
      ]),
      variables: (r: ResolvedRecipient) => ({ name: r.name, reportTitle: report.title, reportUrl }),
      dedupeScope: scope,
      inApp: { linkPath: `/portal/reports/${report.id}` },
      relatedEntity: { type: 'report', id: report.id },
      organizationId: report.organizationId,
      correlationId: event.correlationId ?? null,
    },
  ];
}

export const registeredEventTypes = (): string[] => Object.keys(resolvers);

export interface EventDispatchResult extends DispatchResult {
  handled: boolean;
  requests: number;
}

/** Entry point for the worker: resolves an outbox event to requests and dispatches each. */
export async function dispatchOutboxEvent(
  db: Db,
  event: OutboxEventLike,
  options: PipelineOptions = {},
): Promise<EventDispatchResult> {
  const env = resolveEnv(options);
  const resolver = resolvers[event.type];
  if (!resolver) {
    env.log.info(
      { eventType: event.type, outboxId: event.id },
      'no notification mapping for event; ignored',
    );
    return { handled: false, requests: 0, outcomes: [], retryable: false };
  }
  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : {};
  const scope = `outbox:${event.id}`;
  const requests = await withActor(
    db,
    systemContext(event.correlationId ?? 'notifications'),
    (tx) => resolver({ tx, event, payload, env, scope }),
  );
  const outcomes: EventDispatchResult['outcomes'] = [];
  for (const request of requests) {
    const result = await dispatchRequest(
      db,
      { organizationId: event.organizationId ?? null, ...request },
      options,
    );
    outcomes.push(...result.outcomes);
  }
  return {
    handled: true,
    requests: requests.length,
    outcomes,
    retryable: outcomes.some((o) => o.retryable),
  };
}

/**
 * Resolves an outbox event to its notification requests without sending
 * anything. Used by the admin retry of a failed delivery attempt, which
 * re-renders the same message for one recipient × channel under a new scope.
 */
export async function resolveOutboxEventRequests(
  db: Db,
  event: OutboxEventLike,
  options: PipelineOptions = {},
): Promise<NotificationRequest[]> {
  const env = resolveEnv(options);
  const resolver = resolvers[event.type];
  if (!resolver) return [];
  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : {};
  const scope = `outbox:${event.id}`;
  const requests = await withActor(
    db,
    systemContext(event.correlationId ?? 'notifications'),
    (tx) => resolver({ tx, event, payload, env, scope }),
  );
  return requests.map((r) => ({ organizationId: event.organizationId ?? null, ...r }));
}
