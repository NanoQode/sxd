import { defineMachine, evaluateTransition } from '../workflow/machine';

/**
 * Milestone rules. Three actions are deliberately distinct and none implies
 * another (brief §8): the inspector's progress estimate, the customer's
 * acceptance or rejection, and finance's payment authorisation.
 */

export const MILESTONE_STATES = [
  'pending',
  'in_progress',
  'submitted',
  'accepted',
  'rejected',
] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];

export const milestoneMachine = defineMachine<MilestoneState>({
  name: 'milestone',
  initial: 'pending',
  states: MILESTONE_STATES,
  terminal: ['accepted'],
  transitions: [
    {
      from: 'pending',
      to: 'in_progress',
      by: ['staff', 'partner'],
      permission: 'milestones.record_progress',
      effect: 'Work on the milestone has started.',
    },
    {
      from: 'in_progress',
      to: 'submitted',
      by: ['staff', 'partner'],
      permission: 'projects.manage',
      effect: 'Presented to the customer for acceptance.',
    },
    {
      from: 'submitted',
      to: 'accepted',
      by: ['customer'],
      permission: 'org.milestones.accept',
      effect: 'Customer acceptance recorded; finance authorisation remains a separate step.',
    },
    {
      from: 'submitted',
      to: 'rejected',
      by: ['customer'],
      permission: 'org.milestones.accept',
      reasonRequired: true,
      effect: 'Customer rejected the milestone with a reason; rework follows.',
    },
    {
      from: 'rejected',
      to: 'in_progress',
      by: ['staff', 'partner'],
      permission: 'projects.manage',
      effect: 'Rework after a rejection.',
    },
  ],
});

export type MilestoneAction =
  'record_progress' | 'submit' | 'accept' | 'reject' | 'rework' | 'finance_authorize';

export interface MilestoneActionContext {
  status: MilestoneState;
  percentComplete?: number;
  reason?: string | null;
  financeAuthorizedAt?: string | Date | null;
}

export type MilestoneActionResult =
  | { ok: true; nextStatus: MilestoneState }
  | {
      ok: false;
      code: 'invalid_transition' | 'validation_failed' | 'already_authorized';
      message: string;
    };

export function evaluateMilestoneAction(
  action: MilestoneAction,
  ctx: MilestoneActionContext,
): MilestoneActionResult {
  switch (action) {
    case 'record_progress': {
      const pct = ctx.percentComplete;
      if (pct === undefined || !Number.isInteger(pct) || pct < 0 || pct > 100) {
        return {
          ok: false,
          code: 'validation_failed',
          message: 'percentComplete must be an integer between 0 and 100',
        };
      }
      if (ctx.status === 'accepted' || ctx.status === 'rejected') {
        return {
          ok: false,
          code: 'invalid_transition',
          message: `progress cannot be recorded on a ${ctx.status} milestone`,
        };
      }
      // Recording progress on a pending milestone starts it; it never submits or accepts it.
      if (ctx.status === 'pending') {
        return transition(ctx, 'in_progress', 'staff');
      }
      return { ok: true, nextStatus: ctx.status };
    }
    case 'submit':
      return transition(ctx, 'submitted', 'staff');
    case 'accept':
      return transition(ctx, 'accepted', 'customer');
    case 'reject':
      return transition(ctx, 'rejected', 'customer');
    case 'rework':
      return transition(ctx, 'in_progress', 'staff');
    case 'finance_authorize': {
      if (ctx.status !== 'accepted') {
        return {
          ok: false,
          code: 'invalid_transition',
          message: 'payment can only be authorised for a milestone the customer has accepted',
        };
      }
      if (ctx.financeAuthorizedAt) {
        return {
          ok: false,
          code: 'already_authorized',
          message: 'payment for this milestone was already authorised',
        };
      }
      return { ok: true, nextStatus: ctx.status };
    }
  }
}

function transition(
  ctx: MilestoneActionContext,
  to: MilestoneState,
  actor: 'staff' | 'customer',
): MilestoneActionResult {
  const result = evaluateTransition(milestoneMachine, {
    from: ctx.status,
    to,
    actor,
    reason: ctx.reason ?? null,
  });
  if (!result.ok) {
    return {
      ok: false,
      code: result.code === 'reason_required' ? 'validation_failed' : 'invalid_transition',
      message: result.message,
    };
  }
  return { ok: true, nextStatus: result.to };
}

export interface MilestoneSummaryInput {
  status: MilestoneState;
  plannedDate: string | null;
}

export interface MilestoneSummary {
  total: number;
  byStatus: Record<MilestoneState, number>;
  /** Earliest planned date among milestones not yet accepted. */
  nextPlannedDate: string | null;
}

export function summarizeMilestones(items: MilestoneSummaryInput[]): MilestoneSummary {
  const byStatus: Record<MilestoneState, number> = {
    pending: 0,
    in_progress: 0,
    submitted: 0,
    accepted: 0,
    rejected: 0,
  };
  let next: string | null = null;
  for (const m of items) {
    byStatus[m.status] += 1;
    if (m.status !== 'accepted' && m.plannedDate && (next === null || m.plannedDate < next)) {
      next = m.plannedDate;
    }
  }
  return { total: items.length, byStatus, nextPlannedDate: next };
}
