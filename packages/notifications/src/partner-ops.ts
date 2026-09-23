import { schema, type DbExecutor } from '@simplexd/db';
import type { PipelineEnv } from './env';
import { staffWithRoles } from './recipients';
import type { NotificationChannel, NotificationRequest, RecipientSpec } from './types';

/**
 * Resolvers for the partner-workspace operations: discrepancy responses,
 * unscheduled visits, partner-started conversations and partner invoices.
 * Every event names its recipients (`recipientUserIds`) and, for staff-facing
 * events, the roles that act on them; messages carry ids and status words,
 * never message text or amounts.
 */

interface OutboxEventLike {
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
type StaffRole = (typeof schema.staffRoleEnum.enumValues)[number];

const EMAIL_APP: NotificationChannel[] = ['email', 'in_app'];
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const isUuid = (v: string | null | undefined): v is string =>
  typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
const label = (s: string | null | undefined): string => (s ?? 'updated').replace(/_/g, ' ');

function activity(opts: {
  entityType: string;
  title: (p: Record<string, unknown>) => string;
  message: (p: Record<string, unknown>) => string;
  link: (p: Record<string, unknown>, event: OutboxEventLike) => string;
  channels?: NotificationChannel[];
  staffRoles?: StaffRole[];
  /** Skip the actor even when named as a recipient (they did it themselves). */
  excludeActor?: boolean;
}): EventResolver {
  return async ({ tx, event, payload, env, scope }) => {
    const recipients: RecipientSpec[] = strings(payload['recipientUserIds']).map((userId) => ({
      userId,
    }));
    if (opts.staffRoles) recipients.push(...(await staffWithRoles(tx, opts.staffRoles)));
    const seen = new Set<string>();
    const unique = recipients.filter((r) => {
      const key = r.userId ?? '';
      if (!key || seen.has(key)) return false;
      if (opts.excludeActor !== false && key === event.actorUserId) return false;
      seen.add(key);
      return true;
    });
    if (unique.length === 0) return [];
    const linkPath = opts.link(payload, event);
    return [
      {
        templateKey: 'activity_update',
        category: 'transactional',
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

const poAdminLink = (p: Record<string, unknown>) =>
  `/admin/procurement/purchase-orders/${str(p['purchaseOrderId']) ?? ''}`;
const poPartnerLink = (p: Record<string, unknown>) =>
  `/partner/orders/${str(p['purchaseOrderId']) ?? ''}`;

const invoiceTitles: Record<string, string> = {
  accepted: 'Invoice accepted by finance',
  rejected: 'Invoice rejected',
  second_approved: 'Invoice approved for payment',
  payment_submitted: 'Payment sent to the bank',
  settled: 'Invoice paid',
  payment_failed: 'Payment failed',
};

export const partnerOpsResolvers: Record<string, EventResolver> = {
  'delivery.discrepancy.supplier_responded': activity({
    entityType: 'delivery',
    title: () => 'Supplier responded to a discrepancy',
    message: (p) =>
      `The supplier replied to a delivery discrepancy and proposes to ${label(str(p['proposedResolution']) ?? 'resolve it')}. Accept or reject the proposal.`,
    link: poAdminLink,
    staffRoles: ['operations_manager'],
  }),
  'delivery.discrepancy.decided': activity({
    entityType: 'delivery',
    title: (p) =>
      str(p['decision']) === 'accept'
        ? 'Discrepancy response accepted'
        : 'Discrepancy response rejected',
    message: (p) =>
      str(p['decision']) === 'accept'
        ? `Staff accepted your proposal; the discrepancy is now ${label(str(p['outcome']))}.`
        : 'Staff rejected your proposal and left a reason. You can reply again from the order page.',
    link: poPartnerLink,
  }),
  'project.site_visit.unscheduled_started': activity({
    entityType: 'site_visit',
    title: () => 'Unscheduled site visit started',
    message: () =>
      'An inspector started a visit that was not scheduled and gave a reason. Review it on the project; it can be rejected until its findings are reviewed.',
    link: (p) => `/admin/projects/${str(p['projectId']) ?? ''}`,
    staffRoles: ['operations_manager'],
  }),
  'project.site_visit.rejected': activity({
    entityType: 'site_visit',
    title: () => 'Unscheduled visit rejected',
    message: () =>
      'Staff rejected an unscheduled visit you started; the reason is in the visit record.',
    link: (p) => `/partner/visits/${str(p['siteVisitId']) ?? ''}`,
  }),
  'conversation.partner_started': activity({
    entityType: 'conversation',
    title: () => 'A partner started a conversation',
    message: (p) =>
      `A partner opened a thread with you about a ${label(str(p['entityType']))}. Reply in Messages.`,
    link: (p, e) => `/admin/messages/${str(p['conversationId']) ?? e.aggregateId}`,
  }),
  'partner_invoice.submitted': activity({
    entityType: 'partner_invoice',
    title: () => 'Partner invoice submitted',
    message: (p) =>
      `A partner submitted an invoice against a ${label(str(p['sourceType']))}. Review it under Finance → Partner invoices.`,
    link: () => '/admin/finance/partner-invoices',
    staffRoles: ['finance'],
  }),
  'partner_invoice.transitioned': activity({
    entityType: 'partner_invoice',
    title: (p) => invoiceTitles[str(p['action']) ?? ''] ?? `Invoice ${label(str(p['to']))}`,
    message: (p) =>
      `Your invoice is now ${label(str(p['to']))}. Open Invoices in your workspace for the details and any reason given.`,
    link: () => '/partner/invoices',
  }),
};
