import type {
  ArrearsDto,
  LeaseStatus,
  TenantLeaseSummary,
  TenantNoticeDto,
  WorkOrderDto,
  WorkOrderStatus,
} from '@simplexd/contracts';

/**
 * Pure view-model helpers for the tenant portal (safe in server and client
 * components). Everything here works on data the tenant API already scoped
 * to the caller; nothing derives or invents money, only labels and orders it.
 */

export interface TenantAppointment {
  id: string;
  kind: string;
  status: string;
  startsAt: string;
  endsAt: string;
  topic: string | null;
  locationNote: string | null;
}

/** An invoice raised to the tenant for their own lease (never the owner's ledger). */
export interface TenantInvoice {
  id: string;
  number: string;
  status: string;
  leaseId: string | null;
  currency: string;
  totalKobo: string;
  balanceKobo: string;
  dueDate: string | null;
  issuedAt: string | null;
}

/* ---------------------------------------------------------------------- */
/* Leases                                                                  */
/* ---------------------------------------------------------------------- */

const LEASE_PRIORITY: Record<LeaseStatus, number> = {
  active: 0,
  expiring: 1,
  pending_signature: 2,
  draft: 3,
  ended: 4,
  terminated: 5,
};

/** The lease the home page leads with: live tenancies first, then the latest start date. */
export function pickCurrentLease(leases: TenantLeaseSummary[]): TenantLeaseSummary | null {
  if (leases.length === 0) return null;
  return [...leases].sort((a, b) => {
    const byStatus = LEASE_PRIORITY[a.lease.status] - LEASE_PRIORITY[b.lease.status];
    if (byStatus !== 0) return byStatus;
    return b.lease.startDate.localeCompare(a.lease.startDate);
  })[0]!;
}

/** Leases whose rent is still running (balances and new tickets focus on these). */
export function isLiveLease(status: LeaseStatus): boolean {
  return status === 'active' || status === 'expiring' || status === 'pending_signature';
}

export function leaseTitle(summary: Pick<TenantLeaseSummary, 'property' | 'unit'>): string {
  return summary.unit ? `${summary.property.name} · ${summary.unit.label}` : summary.property.name;
}

export const LEASE_KIND_LABELS: Record<string, string> = {
  residential_annual: 'Residential, annual',
  residential_monthly: 'Residential, monthly',
  commercial: 'Commercial',
  student_academic: 'Student accommodation',
  short_stay_management: 'Short-stay management',
};

export const RENT_PERIOD_LABELS: Record<string, string> = {
  annual: 'per year',
  quarterly: 'per quarter',
  monthly: 'per month',
  term: 'per academic term',
};

export const LEASE_STATUS_COPY: Record<LeaseStatus, string> = {
  draft: 'Being prepared by your landlord. Terms can still change.',
  pending_signature: 'Waiting for signatures before it starts.',
  active: 'In force.',
  expiring: 'In its notice period before the end date.',
  ended: 'Ended. Records stay available here.',
  terminated: 'Terminated early. Records stay available here.',
};

/** Readable one-line address from the free-form address object properties carry. */
export function formatAddress(address: Record<string, unknown> | null | undefined): string | null {
  if (!address) return null;
  const keys = ['line1', 'line2', 'street', 'area', 'city', 'lga', 'state', 'postcode', 'country'];
  const parts: string[] = [];
  for (const key of keys) {
    const value = address[key];
    if (typeof value === 'string' && value.trim() && !parts.includes(value.trim()))
      parts.push(value.trim());
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

/* ---------------------------------------------------------------------- */
/* Balances                                                                */
/* ---------------------------------------------------------------------- */

export const ARREARS_BUCKETS = [
  { key: 'current', label: 'Not yet overdue' },
  { key: 'days_1_30', label: '1–30 days overdue' },
  { key: 'days_31_60', label: '31–60 days overdue' },
  { key: 'days_61_90', label: '61–90 days overdue' },
  { key: 'days_over_90', label: 'More than 90 days overdue' },
] as const;

export function ageingRows(
  arrears: Pick<ArrearsDto, 'buckets'>,
): Array<{ key: string; label: string; amountKobo: string }> {
  return ARREARS_BUCKETS.map((b) => ({
    key: b.key,
    label: b.label,
    amountKobo: arrears.buckets[b.key] ?? '0',
  }));
}

/**
 * Kobo (minor units) string to a display amount without floating point:
 * naira with the ₦ sign, any other currency with its ISO code.
 */
export function formatMoney(kobo: string | null | undefined, currency = 'NGN'): string {
  if (kobo === null || kobo === undefined || kobo === '') return '—';
  const negative = kobo.startsWith('-');
  const digits = negative ? kobo.slice(1) : kobo;
  if (!/^\d+$/.test(digits)) return kobo;
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = padded.slice(-2);
  const amount = fraction === '00' ? whole : `${whole}.${fraction}`;
  const prefix = currency === 'NGN' ? '₦' : `${currency} `;
  return `${negative ? '-' : ''}${prefix}${amount}`;
}

export function isPositiveKobo(kobo: string | null | undefined): boolean {
  return Boolean(kobo && /^\d+$/.test(kobo) && BigInt(kobo) > 0n);
}

/** Sum of the overdue buckets (everything except `current`). */
export function overdueKobo(arrears: Pick<ArrearsDto, 'buckets'>): string {
  let total = 0n;
  for (const b of ARREARS_BUCKETS) {
    if (b.key === 'current') continue;
    const v = arrears.buckets[b.key];
    if (v && /^\d+$/.test(v)) total += BigInt(v);
  }
  return total.toString();
}

/**
 * How to label the balance's `nextDue`: the API returns the next unpaid
 * period due today or later, or else the oldest unpaid one already past due.
 */
export function nextDueCopy(
  nextDue: { dueDate: string } | null,
  asOf: string,
): { label: string; when: string; overdue: boolean } | null {
  if (!nextDue) return null;
  const overdue = nextDue.dueDate < asOf;
  return overdue
    ? { label: 'Oldest unpaid period', when: `was due ${formatDay(nextDue.dueDate)}`, overdue }
    : { label: 'Next charge', when: `due ${formatDay(nextDue.dueDate)}`, overdue };
}

/** Unpaid deposit (the balance endpoint keeps the deposit out of rent arrears). */
export function depositOutstandingKobo(
  charges: Array<{ kind: string; outstandingKobo: string }>,
): string {
  let total = 0n;
  for (const c of charges)
    if (c.kind === 'deposit' && /^\d+$/.test(c.outstandingKobo)) total += BigInt(c.outstandingKobo);
  return total.toString();
}

export const CHARGE_KIND_LABELS: Record<string, string> = {
  rent: 'Rent',
  service_charge: 'Service charge',
  late_fee: 'Late fee',
  utility: 'Utility',
  deposit: 'Deposit',
  other: 'Other charge',
};

export const INVOICE_PAYABLE_STATUSES = new Set(['issued', 'partially_paid', 'overdue']);

/* ---------------------------------------------------------------------- */
/* Maintenance tickets                                                     */
/* ---------------------------------------------------------------------- */

export const TICKET_CATEGORIES = [
  { value: 'plumbing', label: 'Plumbing, leaks and water' },
  { value: 'electrical', label: 'Electrical and power' },
  { value: 'appliance', label: 'Appliances and fittings' },
  { value: 'structural', label: 'Walls, roof, doors and windows' },
  { value: 'security', label: 'Locks and security' },
  { value: 'pest_control', label: 'Pests' },
  { value: 'common_areas', label: 'Shared areas and compound' },
  { value: 'other', label: 'Something else' },
] as const;

export function categoryLabel(value: string): string {
  return TICKET_CATEGORIES.find((c) => c.value === value)?.label ?? humanizeKey(value);
}

/** Priorities with the response target the maintenance service applies (docs/workflows). */
export const TICKET_PRIORITIES = [
  { value: 'low', label: 'Low', target: 'response within 7 days' },
  { value: 'normal', label: 'Normal', target: 'response within 72 hours' },
  { value: 'high', label: 'High', target: 'response within 24 hours' },
  {
    value: 'urgent',
    label: 'Urgent (safety, flooding, no power)',
    target: 'response within 4 hours',
  },
] as const;

const TERMINAL: ReadonlySet<WorkOrderStatus> = new Set(['closed', 'rejected', 'cancelled']);

export function isOpenTicket(ticket: Pick<WorkOrderDto, 'status'>): boolean {
  return !TERMINAL.has(ticket.status) && ticket.status !== 'verified';
}

/** States from which the work-order machine lets a tenant cancel (and only their own report). */
export const TENANT_CANCELLABLE: ReadonlySet<WorkOrderStatus> = new Set([
  'requested',
  'triaged',
  'assigned',
  'awaiting_approval',
]);

export function canTenantCancel(
  ticket: Pick<WorkOrderDto, 'status' | 'reportedByUserId'>,
  userId: string,
): boolean {
  return ticket.reportedByUserId === userId && TENANT_CANCELLABLE.has(ticket.status);
}

export const TICKET_STATUS_COPY: Record<WorkOrderStatus, string> = {
  requested:
    'Received. The maintenance team reviews new requests and sets a response target from the priority.',
  triaged: 'Reviewed by the maintenance team, who are arranging a contractor.',
  assigned:
    'A contractor has been assigned and will arrange access with you or the property manager.',
  in_progress: 'Work has started.',
  awaiting_approval:
    'The contractor sent an estimate that the property owner must approve before work continues.',
  approved: 'The owner approved the work; the contractor continues.',
  completed: 'The contractor reports the work is complete. The team or the owner will check it.',
  verified: 'The work was checked. The ticket will be closed shortly.',
  closed: 'Closed.',
  rejected: 'Declined by the maintenance team or the owner.',
  cancelled: 'Cancelled.',
};

export type StepState = 'done' | 'current' | 'upcoming' | 'ended';

export interface TicketStep {
  key: string;
  label: string;
  state: StepState;
}

const STEPS: Array<{ key: string; label: string }> = [
  { key: 'reported', label: 'Reported' },
  { key: 'reviewed', label: 'Reviewed' },
  { key: 'assigned', label: 'Contractor assigned' },
  { key: 'work', label: 'Work under way' },
  { key: 'completed', label: 'Work completed' },
  { key: 'checked', label: 'Checked and closed' },
];

const STEP_INDEX: Record<WorkOrderStatus, number> = {
  requested: 0,
  triaged: 1,
  assigned: 2,
  in_progress: 3,
  awaiting_approval: 3,
  approved: 3,
  completed: 4,
  verified: 5,
  closed: STEPS.length,
  rejected: -1,
  cancelled: -1,
};

/** Where a ticket stands on the maintenance path; declined and cancelled tickets end early. */
export function ticketProgress(ticket: Pick<WorkOrderDto, 'status'>): TicketStep[] {
  if (ticket.status === 'rejected' || ticket.status === 'cancelled') {
    return [
      { ...STEPS[0]!, state: 'done' },
      {
        key: ticket.status,
        label: ticket.status === 'rejected' ? 'Declined' : 'Cancelled',
        state: 'ended',
      },
    ];
  }
  const current = STEP_INDEX[ticket.status];
  return STEPS.map((s, i) => ({
    ...s,
    state: i < current ? 'done' : i === current ? 'current' : 'upcoming',
  }));
}

export interface TicketEvent {
  id: string;
  title: string;
  at: string;
}

/**
 * Dated events the work order itself records. Intermediate transitions
 * (reviewed, assigned, started) carry no timestamp in the API, so they are
 * shown by the progress steps instead of being given invented dates.
 */
export function ticketEvents(
  ticket: Pick<
    WorkOrderDto,
    'id' | 'status' | 'createdAt' | 'updatedAt' | 'approvedAt' | 'completedAt' | 'verifiedAt'
  >,
): TicketEvent[] {
  const events: TicketEvent[] = [
    { id: 'reported', title: 'You reported it', at: ticket.createdAt },
  ];
  if (ticket.approvedAt)
    events.push({ id: 'approved', title: 'Owner approved the work', at: ticket.approvedAt });
  if (ticket.completedAt)
    events.push({
      id: 'completed',
      title: 'Contractor completed the work',
      at: ticket.completedAt,
    });
  if (ticket.verifiedAt)
    events.push({ id: 'verified', title: 'Work checked', at: ticket.verifiedAt });
  const ending: Partial<Record<WorkOrderStatus, string>> = {
    cancelled: 'Cancelled',
    rejected: 'Declined',
    closed: 'Closed',
  };
  const endTitle = ending[ticket.status];
  if (endTitle) events.push({ id: ticket.status, title: endTitle, at: ticket.updatedAt });
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

/* ---------------------------------------------------------------------- */
/* Appointments and notices                                                */
/* ---------------------------------------------------------------------- */

const INACTIVE_APPOINTMENT = new Set(['cancelled', 'canceled', 'no_show', 'declined', 'expired']);

export function isUpcomingAppointment(a: TenantAppointment, now: Date = new Date()): boolean {
  return !INACTIVE_APPOINTMENT.has(a.status) && new Date(a.endsAt).getTime() >= now.getTime();
}

export function splitAppointments(
  list: TenantAppointment[],
  now: Date = new Date(),
): { upcoming: TenantAppointment[]; past: TenantAppointment[] } {
  const upcoming = list
    .filter((a) => isUpcomingAppointment(a, now))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const past = list
    .filter((a) => !isUpcomingAppointment(a, now))
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  return { upcoming, past };
}

export function unreadCount(notices: Pick<TenantNoticeDto, 'readAt'>[]): number {
  return notices.filter((n) => !n.readAt).length;
}

/* ---------------------------------------------------------------------- */
/* Invitations                                                             */
/* ---------------------------------------------------------------------- */

export const INVITATION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

export type InvitationFailure =
  'used_or_revoked' | 'expired' | 'wrong_email' | 'conflict' | 'error';

/** Maps the accept endpoint's answer to what the person should do next. */
export function classifyInvitationError(code: string | null, message: string): InvitationFailure {
  if (code === 'not_found') return 'used_or_revoked';
  if (code === 'forbidden') return 'wrong_email';
  if (code === 'conflict') return /expired/i.test(message) ? 'expired' : 'conflict';
  return 'error';
}

export const INVITATION_FAILURE_COPY: Record<InvitationFailure, { title: string; body: string }> = {
  used_or_revoked: {
    title: 'This invitation can no longer be used',
    body: 'It was already accepted, revoked by your landlord, or replaced by a newer invitation. If you accepted it already, your lease is on your tenant home. Otherwise ask your landlord or property manager for a new invitation.',
  },
  expired: {
    title: 'This invitation has expired',
    body: 'Invitations are valid for a limited time. Ask your landlord or property manager to send a new one.',
  },
  wrong_email: {
    title: 'Signed in with a different email',
    body: 'The invitation was sent to another email address. Sign out and sign in (or create an account) with the invited address.',
  },
  conflict: {
    title: 'The invitation changed while you were accepting it',
    body: 'Reload this page to see its current state before trying again.',
  },
  error: {
    title: 'Could not accept the invitation',
    body: 'Nothing was changed. Try again in a moment.',
  },
};

/* ---------------------------------------------------------------------- */
/* Misc                                                                    */
/* ---------------------------------------------------------------------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A calendar date without time (`YYYY-MM-DD`) as "22 Sep 2026". Date-only
 * values are never shifted through a time zone, so due dates read the same
 * everywhere.
 */
export function formatDay(date: string | null | undefined): string {
  if (!date) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return date;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : date;
}

export function humanizeKey(value: string): string {
  return value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
