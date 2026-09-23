import { reportMachine, type ReportState } from '../workflow/machines';
import { evaluateTransition } from '../workflow/machine';

/**
 * Report review rules (brief §8, §10): a named professional reviewer who is
 * not the author, staff review before release, and frozen released versions.
 */

export type ReportRevisionState = ReportState;

export interface RevisionStateInput {
  version: number;
  currentVersion: number;
  releasedVersion: number | null;
  reportStatus: ReportState;
}

/**
 * The state of one revision derived from the report row: the released
 * version is `released`, older versions are `superseded`, and the current
 * working version carries the report status.
 */
export function revisionState(input: RevisionStateInput): ReportRevisionState {
  if (input.releasedVersion !== null && input.version === input.releasedVersion) return 'released';
  if (input.version === input.currentVersion) {
    return input.reportStatus === 'released' ? 'released' : input.reportStatus;
  }
  return 'superseded';
}

export type ReviewerCheck = { ok: true } | { ok: false; reason: string };

/** The named reviewer must be a different person from the author. */
export function validateNamedReviewer(input: {
  authorUserId: string | null;
  reviewerUserId: string | null | undefined;
}): ReviewerCheck {
  if (!input.reviewerUserId) return { ok: false, reason: 'a named professional reviewer is required' };
  if (input.authorUserId && input.authorUserId === input.reviewerUserId) {
    return { ok: false, reason: 'the named reviewer must not be the author of the report' };
  }
  return { ok: true };
}

/** Nobody reviews or releases their own report, whatever their role. */
export function assertNotAuthor(input: {
  authorUserId: string | null;
  actorUserId: string;
  action: 'review' | 'release';
}): ReviewerCheck {
  if (input.authorUserId && input.authorUserId === input.actorUserId) {
    return { ok: false, reason: `the author of a report cannot ${input.action} it` };
  }
  return { ok: true };
}

export type AddRevisionDecision =
  | { ok: true; nextStatus: 'draft' | 'changes_requested'; supersedesRelease: boolean }
  | { ok: false; reason: string };

/**
 * Whether a new revision may be added given the report status:
 * - draft / changes_requested: yes, status unchanged;
 * - released: yes, a new working version starts in draft while the released
 *   version stays frozen and customer-visible until a newer release supersedes it;
 * - in_review / approved: no, the review must be decided or reopened first.
 */
export function canAddRevision(status: ReportState): AddRevisionDecision {
  switch (status) {
    case 'draft':
      return { ok: true, nextStatus: 'draft', supersedesRelease: false };
    case 'changes_requested':
      return { ok: true, nextStatus: 'changes_requested', supersedesRelease: false };
    case 'released':
      return { ok: true, nextStatus: 'draft', supersedesRelease: true };
    case 'in_review':
      return { ok: false, reason: 'the report is under review; wait for the decision' };
    case 'approved':
      return {
        ok: false,
        reason: 'the report is approved for release; reopen it with a reason before editing',
      };
    case 'superseded':
      return { ok: false, reason: 'a superseded report cannot be edited' };
  }
}

export type ReviewDecision = 'approved' | 'changes_requested';

export interface ReportTransitionCheck {
  ok: boolean;
  to: ReportState;
  message?: string;
  code?: string;
}

/** Runs the shared report state machine for a staff-side transition. */
export function reportTransition(
  from: ReportState,
  to: ReportState,
  actor: 'staff' | 'partner' | 'system',
  reason?: string | null,
): ReportTransitionCheck {
  const result = evaluateTransition(reportMachine, { from, to, actor, reason: reason ?? null });
  if (result.ok) return { ok: true, to };
  return { ok: false, to, message: result.message, code: result.code };
}

export function reviewTransitionTarget(decision: ReviewDecision): ReportState {
  return decision === 'approved' ? 'approved' : 'changes_requested';
}
