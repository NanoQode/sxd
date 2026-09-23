import { defineMachine } from '../workflow/machine';

/** Project lifecycle: planning → active → on_hold/completed → cancelled → archived. */
export const PROJECT_STATES = [
  'planning',
  'active',
  'on_hold',
  'completed',
  'cancelled',
  'archived',
] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export const projectMachine = defineMachine<ProjectState>({
  name: 'project',
  initial: 'planning',
  states: PROJECT_STATES,
  terminal: ['archived'],
  transitions: [
    { from: 'planning', to: 'active', by: ['staff'], permission: 'projects.manage' },
    {
      from: 'active',
      to: 'on_hold',
      by: ['staff'],
      permission: 'projects.manage',
      reasonRequired: true,
      effect: 'Site visits and reporting pause; the reason is shown to the customer.',
    },
    { from: 'on_hold', to: 'active', by: ['staff'], permission: 'projects.manage' },
    {
      from: 'active',
      to: 'completed',
      by: ['staff'],
      permission: 'projects.manage',
      effect: 'Deliverables released; unresolved defects remain listed.',
    },
    {
      from: ['planning', 'active', 'on_hold'],
      to: 'cancelled',
      by: ['staff'],
      permission: 'projects.manage',
      reasonRequired: true,
      effect: 'Billing consequences follow the engagement policy.',
    },
    {
      from: ['completed', 'cancelled'],
      to: 'archived',
      by: ['staff'],
      permission: 'projects.manage',
      effect: 'Read-only; evidence is retained, never deleted.',
    },
  ],
});

/** Defect lifecycle with accountability and independent verification. */
export const DEFECT_STATES = [
  'open',
  'acknowledged',
  'in_progress',
  'resolved',
  'verified',
  'closed',
  'disputed',
] as const;
export type DefectState = (typeof DEFECT_STATES)[number];

export const defectMachine = defineMachine<DefectState>({
  name: 'defect',
  initial: 'open',
  states: DEFECT_STATES,
  terminal: ['closed'],
  transitions: [
    { from: 'open', to: 'acknowledged', by: ['staff', 'partner'] },
    { from: ['open', 'acknowledged'], to: 'in_progress', by: ['staff', 'partner'] },
    {
      from: ['acknowledged', 'in_progress'],
      to: 'resolved',
      by: ['staff', 'partner'],
      effect: 'Accountable party reports the fix; evidence expected.',
    },
    {
      from: 'resolved',
      to: 'verified',
      by: ['staff'],
      permission: 'reports.review',
      effect: 'Verified by someone other than the resolver.',
    },
    {
      from: 'resolved',
      to: 'in_progress',
      by: ['staff', 'customer'],
      reasonRequired: true,
      effect: 'Verification failed; back to work.',
    },
    { from: 'verified', to: 'closed', by: ['staff'] },
    {
      from: ['acknowledged', 'in_progress', 'resolved', 'verified'],
      to: 'disputed',
      by: ['customer', 'staff', 'partner'],
      reasonRequired: true,
    },
    { from: 'disputed', to: 'in_progress', by: ['staff'], reasonRequired: true },
    { from: 'disputed', to: 'closed', by: ['staff'], reasonRequired: true },
    {
      from: 'open',
      to: 'closed',
      by: ['staff'],
      reasonRequired: true,
      effect: 'Closed without work (duplicate or not a defect).',
    },
  ],
});

/** Defects still needing attention for the unresolved-issues list. */
export const UNRESOLVED_DEFECT_STATES: readonly DefectState[] = [
  'open',
  'acknowledged',
  'in_progress',
  'resolved',
  'disputed',
];

/** Permit applications: statuses follow the appended events. */
export const PERMIT_STATES = [
  'preparing',
  'submitted',
  'query_raised',
  'resubmitted',
  'approved',
  'rejected',
  'withdrawn',
] as const;
export type PermitState = (typeof PERMIT_STATES)[number];

export const PERMIT_EVENT_TYPES = [
  'submitted',
  'query_raised',
  'resubmitted',
  'approved',
  'rejected',
  'withdrawn',
  'fee_paid',
  'completeness_confirmed',
  'note',
] as const;
export type PermitEventKind = (typeof PERMIT_EVENT_TYPES)[number];

const PERMIT_TERMINAL: readonly PermitState[] = ['approved', 'rejected', 'withdrawn'];

export type PermitEventDecision =
  { ok: true; status: PermitState; changed: boolean } | { ok: false; message: string };

/** Which status an event moves the application to; informational events leave it unchanged. */
export function permitStatusAfterEvent(
  status: PermitState,
  eventType: PermitEventKind,
): PermitEventDecision {
  const unchanged: PermitEventDecision = { ok: true, status, changed: false };
  if (eventType === 'note') return unchanged;
  if (PERMIT_TERMINAL.includes(status)) {
    return { ok: false, message: `application is ${status}; only notes can be added` };
  }
  switch (eventType) {
    case 'fee_paid':
    case 'completeness_confirmed':
      return unchanged;
    case 'submitted':
      return status === 'preparing'
        ? { ok: true, status: 'submitted', changed: true }
        : { ok: false, message: `cannot submit an application that is ${status}` };
    case 'query_raised':
      return status === 'submitted' || status === 'resubmitted'
        ? { ok: true, status: 'query_raised', changed: true }
        : {
            ok: false,
            message: `a query can only be raised while the authority holds the application`,
          };
    case 'resubmitted':
      return status === 'query_raised'
        ? { ok: true, status: 'resubmitted', changed: true }
        : { ok: false, message: 'resubmission is only possible after a query' };
    case 'approved':
    case 'rejected':
      return status === 'submitted' || status === 'resubmitted'
        ? { ok: true, status: eventType, changed: true }
        : {
            ok: false,
            message: `a decision requires a submitted application (currently ${status})`,
          };
    case 'withdrawn':
      return { ok: true, status: 'withdrawn', changed: true };
  }
}
