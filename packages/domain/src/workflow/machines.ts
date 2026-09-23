import { defineMachine } from './machine';

/**
 * Shared engagement pipeline for every service:
 * inquiry → triage → scoped quotation → customer acceptance → invoice/payment
 * where required → assigned work → evidence/review → customer delivery →
 * completion → feedback. Rejected, paused and cancelled paths need reasons and
 * appropriate billing consequences.
 */
export const ENGAGEMENT_STATES = [
  'inquiry',
  'triage',
  'quoted',
  'accepted',
  'awaiting_payment',
  'in_progress',
  'in_review',
  'delivered',
  'completed',
  'rejected',
  'paused',
  'cancelled',
] as const;
export type EngagementState = (typeof ENGAGEMENT_STATES)[number];

export const engagementMachine = defineMachine<EngagementState>({
  name: 'engagement',
  initial: 'inquiry',
  states: ENGAGEMENT_STATES,
  terminal: ['completed', 'rejected', 'cancelled'],
  transitions: [
    {
      from: 'inquiry',
      to: 'triage',
      by: ['staff', 'system'],
      permission: 'service_requests.triage',
    },
    {
      from: 'triage',
      to: 'quoted',
      by: ['staff'],
      permission: 'quotes.issue',
      effect: 'A quote version is issued to the customer.',
    },
    {
      from: 'triage',
      to: 'rejected',
      by: ['staff'],
      permission: 'service_requests.triage',
      reasonRequired: true,
      effect: 'No billing.',
    },
    {
      from: 'quoted',
      to: 'quoted',
      by: ['staff'],
      permission: 'quotes.issue',
      effect: 'A new quote version supersedes the previous one.',
    },
    {
      from: 'quoted',
      to: 'accepted',
      by: ['customer'],
      permission: 'org.quotes.accept',
      effect: 'Acceptance recorded with signature name, terms version and IP hash.',
    },
    {
      from: 'quoted',
      to: 'rejected',
      by: ['customer', 'staff'],
      reasonRequired: true,
      effect: 'No billing.',
    },
    {
      from: 'accepted',
      to: 'awaiting_payment',
      by: ['system', 'staff'],
      permission: 'finance.invoices.manage',
      effect: 'Deposit or full invoice issued.',
    },
    {
      from: 'accepted',
      to: 'in_progress',
      by: ['staff', 'system'],
      permission: 'service_requests.assign',
      effect: 'Work starts without upfront payment (policy decision).',
    },
    {
      from: 'awaiting_payment',
      to: 'in_progress',
      by: ['system', 'staff'],
      permission: 'service_requests.override',
      effect: 'Verified payment or staff override with reason.',
    },
    {
      from: 'in_progress',
      to: 'in_review',
      by: ['staff', 'partner'],
      effect: 'Deliverable submitted for review.',
    },
    {
      from: 'in_review',
      to: 'in_progress',
      by: ['staff'],
      permission: 'reports.review',
      reasonRequired: true,
      effect: 'Changes requested.',
    },
    {
      from: 'in_review',
      to: 'delivered',
      by: ['staff'],
      permission: 'reports.release',
      effect: 'Reviewed deliverable released to the customer.',
    },
    {
      from: 'delivered',
      to: 'completed',
      by: ['customer', 'system'],
      effect: 'Customer confirms or auto-completes after the review window; feedback requested.',
    },
    {
      from: 'delivered',
      to: 'in_progress',
      by: ['customer', 'staff'],
      reasonRequired: true,
      effect: 'Customer disputes the deliverable; rework.',
    },
    {
      from: ['accepted', 'awaiting_payment', 'in_progress', 'in_review'],
      to: 'paused',
      by: ['staff', 'customer'],
      reasonRequired: true,
      effect: 'SLA clock stops; no new invoices.',
    },
    { from: 'paused', to: 'in_progress', by: ['staff', 'customer'], effect: 'SLA clock resumes.' },
    {
      from: ['inquiry', 'triage', 'quoted'],
      to: 'cancelled',
      by: ['customer', 'staff'],
      reasonRequired: true,
      effect: 'No billing.',
    },
    {
      from: ['accepted', 'awaiting_payment', 'in_progress', 'in_review', 'delivered', 'paused'],
      to: 'cancelled',
      by: ['staff', 'customer'],
      reasonRequired: true,
      effect:
        'Unpaid invoices are voided; paid work is invoiced pro rata or refunded per policy; finance reviews.',
    },
  ],
});

export const INVOICE_STATES = [
  'draft',
  'issued',
  'partially_paid',
  'paid',
  'overdue',
  'void',
] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];

export const invoiceMachine = defineMachine<InvoiceState>({
  name: 'invoice',
  initial: 'draft',
  states: INVOICE_STATES,
  terminal: ['void'],
  transitions: [
    { from: 'draft', to: 'issued', by: ['staff', 'system'], permission: 'finance.invoices.manage' },
    {
      from: ['issued', 'overdue'],
      to: 'partially_paid',
      by: ['system'],
      effect: 'An allocation smaller than the balance was posted.',
    },
    {
      from: ['issued', 'overdue', 'partially_paid'],
      to: 'paid',
      by: ['system'],
      effect: 'Allocations cover the total.',
    },
    {
      from: ['issued', 'partially_paid'],
      to: 'overdue',
      by: ['system'],
      effect: 'Due date passed with a balance outstanding.',
    },
    { from: ['overdue'], to: 'issued', by: ['system'], effect: 'Due date extended by finance.' },
    {
      from: ['draft', 'issued', 'overdue'],
      to: 'void',
      by: ['staff'],
      permission: 'finance.invoices.manage',
      reasonRequired: true,
      effect: 'Only when nothing has been allocated; otherwise issue a credit note.',
    },
  ],
});

export const PAYMENT_ATTEMPT_STATES = [
  'initialized',
  'pending',
  'successful',
  'failed',
  'reversed',
  'uncertain',
  'abandoned',
] as const;
export type PaymentAttemptState = (typeof PAYMENT_ATTEMPT_STATES)[number];

export const paymentAttemptMachine = defineMachine<PaymentAttemptState>({
  name: 'payment_attempt',
  initial: 'initialized',
  states: PAYMENT_ATTEMPT_STATES,
  terminal: ['failed', 'reversed', 'abandoned'],
  transitions: [
    {
      from: 'initialized',
      to: 'pending',
      by: ['system'],
      effect: 'Customer redirected or checkout opened.',
    },
    {
      from: ['initialized', 'pending', 'uncertain'],
      to: 'successful',
      by: ['system'],
      effect: 'Server-side verification matched status, reference, amount and currency.',
    },
    { from: ['initialized', 'pending', 'uncertain'], to: 'failed', by: ['system'] },
    {
      from: ['initialized', 'pending'],
      to: 'uncertain',
      by: ['system'],
      effect: 'Provider status unknown; reconciliation job will resolve.',
    },
    {
      from: ['initialized', 'pending'],
      to: 'abandoned',
      by: ['system'],
      effect: 'No provider activity within the attempt window.',
    },
    {
      from: 'successful',
      to: 'reversed',
      by: ['system'],
      effect: 'Chargeback or provider reversal; reversing journal posted.',
    },
  ],
});

export const REFUND_STATES = [
  'requested',
  'approved',
  'submitted',
  'pending',
  'settled',
  'failed',
  'rejected',
] as const;
export type RefundState = (typeof REFUND_STATES)[number];

export const refundMachine = defineMachine<RefundState>({
  name: 'refund',
  initial: 'requested',
  states: REFUND_STATES,
  terminal: ['settled', 'rejected'],
  transitions: [
    {
      from: 'requested',
      to: 'approved',
      by: ['staff'],
      permission: 'finance.refunds.approve',
      effect: 'Requires step-up authentication and a different approver than the requester.',
    },
    {
      from: 'requested',
      to: 'rejected',
      by: ['staff'],
      permission: 'finance.refunds.approve',
      reasonRequired: true,
    },
    {
      from: 'approved',
      to: 'submitted',
      by: ['system'],
      effect: 'Sent to the provider; submission alone is not settlement.',
    },
    {
      from: 'submitted',
      to: 'pending',
      by: ['system'],
      effect: 'Provider acknowledged and is processing.',
    },
    {
      from: ['submitted', 'pending'],
      to: 'settled',
      by: ['system'],
      effect: 'Provider confirmed processed; settlement journal posted.',
    },
    { from: ['submitted', 'pending'], to: 'failed', by: ['system'], reasonRequired: true },
    {
      from: 'failed',
      to: 'approved',
      by: ['staff'],
      permission: 'finance.refunds.approve',
      reasonRequired: true,
      effect: 'Retry with corrected details.',
    },
  ],
});

export const TENDER_STATES = [
  'draft',
  'published',
  'clarifications',
  'closed',
  'evaluating',
  'awarded',
  'cancelled',
] as const;
export type TenderState = (typeof TENDER_STATES)[number];

export const tenderMachine = defineMachine<TenderState>({
  name: 'tender',
  initial: 'draft',
  states: TENDER_STATES,
  terminal: ['awarded', 'cancelled'],
  transitions: [
    {
      from: 'draft',
      to: 'published',
      by: ['staff'],
      permission: 'tenders.manage',
      effect: 'Invitations sent; timeline validated.',
    },
    {
      from: 'published',
      to: 'clarifications',
      by: ['system', 'staff'],
      effect: 'Question window open.',
    },
    {
      from: ['published', 'clarifications'],
      to: 'closed',
      by: ['system'],
      effect: 'Submission deadline reached (server time).',
    },
    {
      from: 'closed',
      to: 'evaluating',
      by: ['staff'],
      permission: 'bids.evaluate',
      effect: 'Sealed bids opened and access logged.',
    },
    {
      from: 'evaluating',
      to: 'awarded',
      by: ['staff'],
      permission: 'tenders.manage',
      effect: 'Award decided; contractors notified only when published.',
    },
    {
      from: ['draft', 'published', 'clarifications', 'closed', 'evaluating'],
      to: 'cancelled',
      by: ['staff'],
      permission: 'tenders.manage',
      reasonRequired: true,
    },
  ],
});

export const BID_STATES = [
  'draft',
  'submitted',
  'withdrawn',
  'disqualified',
  'evaluated',
  'awarded',
  'unsuccessful',
] as const;
export type BidState = (typeof BID_STATES)[number];

export const bidMachine = defineMachine<BidState>({
  name: 'bid',
  initial: 'draft',
  states: BID_STATES,
  terminal: ['withdrawn', 'disqualified', 'awarded', 'unsuccessful'],
  transitions: [
    {
      from: 'draft',
      to: 'submitted',
      by: ['partner'],
      permission: 'partner.bids.submit',
      effect: 'Only before the effective deadline; atomic server check.',
    },
    {
      from: 'submitted',
      to: 'submitted',
      by: ['partner'],
      permission: 'partner.bids.submit',
      effect: 'New revision before the deadline.',
    },
    { from: ['draft', 'submitted'], to: 'withdrawn', by: ['partner'], reasonRequired: true },
    {
      from: 'submitted',
      to: 'disqualified',
      by: ['staff'],
      permission: 'bids.evaluate',
      reasonRequired: true,
    },
    { from: 'submitted', to: 'evaluated', by: ['staff'], permission: 'bids.evaluate' },
    { from: 'evaluated', to: 'awarded', by: ['staff'], permission: 'tenders.manage' },
    { from: 'evaluated', to: 'unsuccessful', by: ['staff', 'system'] },
  ],
});

export const WORK_ORDER_STATES = [
  'requested',
  'triaged',
  'assigned',
  'in_progress',
  'awaiting_approval',
  'approved',
  'completed',
  'verified',
  'closed',
  'rejected',
  'cancelled',
] as const;
export type WorkOrderState = (typeof WORK_ORDER_STATES)[number];

export const workOrderMachine = defineMachine<WorkOrderState>({
  name: 'work_order',
  initial: 'requested',
  states: WORK_ORDER_STATES,
  terminal: ['closed', 'rejected', 'cancelled'],
  transitions: [
    { from: 'requested', to: 'triaged', by: ['staff'], permission: 'maintenance.manage' },
    {
      from: 'requested',
      to: 'rejected',
      by: ['staff'],
      permission: 'maintenance.manage',
      reasonRequired: true,
    },
    {
      from: 'triaged',
      to: 'assigned',
      by: ['staff'],
      permission: 'maintenance.manage',
      effect: 'Contractor dispatched.',
    },
    { from: 'assigned', to: 'in_progress', by: ['partner', 'staff'] },
    {
      from: ['triaged', 'assigned', 'in_progress'],
      to: 'awaiting_approval',
      by: ['staff', 'partner'],
      effect: 'Estimate above threshold requires owner approval.',
    },
    {
      from: 'awaiting_approval',
      to: 'approved',
      by: ['customer'],
      permission: 'org.change_orders.approve',
    },
    { from: 'awaiting_approval', to: 'rejected', by: ['customer'], reasonRequired: true },
    {
      from: ['approved', 'in_progress'],
      to: 'completed',
      by: ['partner', 'staff'],
      effect: 'Evidence attached.',
    },
    {
      from: 'completed',
      to: 'verified',
      by: ['staff', 'customer'],
      effect: 'Work verified; expense recorded.',
    },
    {
      from: 'verified',
      to: 'closed',
      by: ['staff', 'system'],
      effect: 'Expense journal posted; recoverable charge raised if applicable.',
    },
    {
      from: ['requested', 'triaged', 'assigned', 'awaiting_approval'],
      to: 'cancelled',
      by: ['staff', 'customer', 'tenant'],
      reasonRequired: true,
    },
  ],
});

export const CHANGE_ORDER_STATES = [
  'draft',
  'submitted',
  'customer_review',
  'staff_review',
  'approved',
  'rejected',
  'withdrawn',
] as const;
export type ChangeOrderState = (typeof CHANGE_ORDER_STATES)[number];

export const changeOrderMachine = defineMachine<ChangeOrderState>({
  name: 'change_order',
  initial: 'draft',
  states: CHANGE_ORDER_STATES,
  terminal: ['approved', 'rejected', 'withdrawn'],
  transitions: [
    { from: 'draft', to: 'submitted', by: ['staff', 'partner'] },
    { from: 'submitted', to: 'staff_review', by: ['system'] },
    {
      from: 'staff_review',
      to: 'customer_review',
      by: ['staff'],
      permission: 'change_orders.staff_approve',
      effect: 'Staff approval recorded; customer approval still required by policy.',
    },
    {
      from: ['staff_review', 'customer_review'],
      to: 'rejected',
      by: ['staff', 'customer'],
      reasonRequired: true,
    },
    {
      from: 'customer_review',
      to: 'approved',
      by: ['customer'],
      permission: 'org.change_orders.approve',
      effect: 'Only now does the approved budget version change.',
    },
    {
      from: ['draft', 'submitted', 'staff_review', 'customer_review'],
      to: 'withdrawn',
      by: ['staff', 'partner'],
      reasonRequired: true,
    },
  ],
});

export const REPORT_STATES = [
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'released',
  'superseded',
] as const;
export type ReportState = (typeof REPORT_STATES)[number];

export const reportMachine = defineMachine<ReportState>({
  name: 'report',
  initial: 'draft',
  states: REPORT_STATES,
  terminal: ['superseded'],
  transitions: [
    {
      from: ['draft', 'changes_requested'],
      to: 'in_review',
      by: ['staff', 'partner'],
      effect: 'A revision is submitted; the named reviewer must differ from the author.',
    },
    {
      from: 'in_review',
      to: 'changes_requested',
      by: ['staff'],
      permission: 'reports.review',
      reasonRequired: true,
    },
    { from: 'in_review', to: 'approved', by: ['staff'], permission: 'reports.review' },
    {
      from: 'approved',
      to: 'released',
      by: ['staff'],
      permission: 'reports.release',
      effect: 'Customer notified; report visible in the portal.',
    },
    {
      from: 'released',
      to: 'superseded',
      by: ['staff', 'system'],
      effect: 'A newer released version replaces it; history retained.',
    },
    {
      from: 'approved',
      to: 'draft',
      by: ['staff'],
      permission: 'reports.review',
      reasonRequired: true,
    },
  ],
});

export const LISTING_STATES = [
  'draft',
  'in_moderation',
  'published',
  'paused',
  'expired',
  'withdrawn',
  'archived',
  'rejected',
] as const;
export type ListingState = (typeof LISTING_STATES)[number];

export const listingMachine = defineMachine<ListingState>({
  name: 'listing',
  initial: 'draft',
  states: LISTING_STATES,
  terminal: ['archived'],
  transitions: [
    {
      from: ['draft', 'rejected', 'published'],
      to: 'in_moderation',
      by: ['customer', 'staff'],
      permission: 'org.listings.manage',
      effect:
        'Owner authority and content are checked before publication; a published listing stays live on its approved revision while changes are reviewed.',
    },
    { from: 'in_moderation', to: 'published', by: ['staff'], permission: 'content.publish' },
    {
      from: 'in_moderation',
      to: 'rejected',
      by: ['staff'],
      permission: 'content.publish',
      reasonRequired: true,
    },
    {
      from: 'in_moderation',
      to: 'draft',
      by: ['staff'],
      permission: 'content.publish',
      reasonRequired: true,
      effect: 'Changes requested; the owner edits and resubmits.',
    },
    { from: 'published', to: 'paused', by: ['customer', 'staff'] },
    {
      from: 'paused',
      to: 'published',
      by: ['customer', 'staff'],
      effect: 'Availability must be re-confirmed.',
    },
    {
      from: 'published',
      to: 'expired',
      by: ['system'],
      effect: 'Availability confirmation lapsed.',
    },
    {
      from: 'expired',
      to: 'in_moderation',
      by: ['customer'],
      effect: 'Re-confirmed availability triggers moderation.',
    },
    {
      from: ['published', 'paused', 'expired', 'in_moderation'],
      to: 'withdrawn',
      by: ['customer', 'staff'],
      reasonRequired: true,
    },
    {
      from: ['draft', 'withdrawn', 'expired', 'rejected'],
      to: 'archived',
      by: ['customer', 'staff', 'system'],
    },
    {
      from: ['published', 'paused', 'in_moderation'],
      to: 'archived',
      by: ['customer', 'staff'],
      effect: 'A documented sale or lease outcome closes the listing.',
    },
  ],
});

export const LISTING_OFFER_STATES = [
  'draft',
  'submitted',
  'countered',
  'accepted',
  'rejected',
  'withdrawn',
  'expired',
] as const;
export type ListingOfferState = (typeof LISTING_OFFER_STATES)[number];

/**
 * Offers on a published listing. The buyer's organisation owns the offer and
 * the listing owner's organisation is the counterparty. `submitted` means the
 * buyer's figure awaits the owner; `countered` means the owner's figure awaits
 * the buyer. Every step appends to the offer's negotiation log.
 */
export const listingOfferMachine = defineMachine<ListingOfferState>({
  name: 'listing_offer',
  initial: 'submitted',
  states: LISTING_OFFER_STATES,
  terminal: ['accepted', 'rejected', 'withdrawn', 'expired'],
  transitions: [
    {
      from: 'submitted',
      to: 'countered',
      by: ['customer'],
      permission: 'org.listings.manage',
      effect: 'The owner proposes a different amount.',
    },
    {
      from: 'countered',
      to: 'submitted',
      by: ['customer'],
      permission: 'org.requests.create',
      effect: 'The buyer answers the counter-offer with a new amount.',
    },
    {
      from: ['submitted', 'countered'],
      to: 'accepted',
      by: ['customer'],
      effect: 'The party whose turn it is accepts the latest amount.',
    },
    {
      from: ['submitted', 'countered'],
      to: 'rejected',
      by: ['customer'],
      permission: 'org.listings.manage',
      reasonRequired: true,
    },
    {
      from: ['submitted', 'countered'],
      to: 'withdrawn',
      by: ['customer'],
      permission: 'org.requests.create',
    },
    {
      from: ['submitted', 'countered'],
      to: 'expired',
      by: ['system'],
      effect: 'The validity date passed without a decision.',
    },
  ],
});

export const LEASE_STATES = [
  'draft',
  'pending_signature',
  'active',
  'expiring',
  'ended',
  'terminated',
] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

export const leaseMachine = defineMachine<LeaseState>({
  name: 'lease',
  initial: 'draft',
  states: LEASE_STATES,
  terminal: ['ended', 'terminated'],
  transitions: [
    { from: 'draft', to: 'pending_signature', by: ['staff', 'customer'] },
    {
      from: ['draft', 'pending_signature'],
      to: 'active',
      by: ['staff', 'customer'],
      effect: 'Rent schedule generated.',
    },
    {
      from: 'active',
      to: 'expiring',
      by: ['system'],
      effect: 'Within the notice period of the end date.',
    },
    { from: ['active', 'expiring'], to: 'ended', by: ['system', 'staff'] },
    {
      from: ['active', 'expiring'],
      to: 'terminated',
      by: ['staff', 'customer'],
      reasonRequired: true,
      effect: 'Deposit and arrears settled per statement.',
    },
  ],
});

export const APPOINTMENT_STATES = [
  'pending_confirmation',
  'confirmed',
  'rescheduled',
  'cancelled',
  'completed',
  'no_show',
] as const;
export type AppointmentState = (typeof APPOINTMENT_STATES)[number];

export const appointmentMachine = defineMachine<AppointmentState>({
  name: 'appointment',
  initial: 'pending_confirmation',
  states: APPOINTMENT_STATES,
  terminal: ['cancelled', 'completed', 'no_show'],
  transitions: [
    {
      from: 'pending_confirmation',
      to: 'confirmed',
      by: ['system', 'staff'],
      effect: 'Slot reservation converted; calendar sync queued.',
    },
    {
      from: ['confirmed', 'rescheduled'],
      to: 'rescheduled',
      by: ['customer', 'staff', 'system'],
      effect: 'Linked calendar event updated; reminders reset.',
    },
    {
      from: ['pending_confirmation', 'confirmed', 'rescheduled'],
      to: 'cancelled',
      by: ['customer', 'staff', 'system'],
      reasonRequired: true,
      effect: 'Capacity released; attendees notified; calendar event cancelled.',
    },
    { from: ['confirmed', 'rescheduled'], to: 'completed', by: ['staff', 'system'] },
    { from: ['confirmed', 'rescheduled'], to: 'no_show', by: ['staff'] },
  ],
});

export const PAYOUT_STATES = [
  'proposed',
  'first_approved',
  'approved',
  'submitted',
  'settled',
  'failed',
  'rejected',
] as const;
export type PayoutState = (typeof PAYOUT_STATES)[number];

export const payoutMachine = defineMachine<PayoutState>({
  name: 'payout',
  initial: 'proposed',
  states: PAYOUT_STATES,
  terminal: ['settled', 'rejected'],
  transitions: [
    {
      from: 'proposed',
      to: 'first_approved',
      by: ['staff'],
      permission: 'finance.payouts.first_approve',
      effect: 'Requires reconciliation to be balanced.',
    },
    {
      from: 'first_approved',
      to: 'approved',
      by: ['staff'],
      permission: 'finance.payouts.second_approve',
      effect: 'Second approver must differ from the first.',
    },
    {
      from: ['proposed', 'first_approved'],
      to: 'rejected',
      by: ['staff'],
      permission: 'finance.payouts.first_approve',
      reasonRequired: true,
    },
    { from: 'approved', to: 'submitted', by: ['system'] },
    { from: 'submitted', to: 'settled', by: ['system'] },
    { from: 'submitted', to: 'failed', by: ['system'], reasonRequired: true },
    {
      from: 'failed',
      to: 'approved',
      by: ['staff'],
      permission: 'finance.payouts.second_approve',
      reasonRequired: true,
    },
  ],
});
