/**
 * Approval policy for budgets and change orders. A change order (or a budget
 * version) declares which approvals it requires; the policy is satisfied only
 * when every required role has an approved record and none has a rejected
 * one. Approvals from roles the policy does not require are recorded but never
 * count towards satisfaction.
 */

export type ApproverRole = 'customer' | 'staff';

export type ApprovalRecordStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'withdrawn';

export interface ApprovalPolicy {
  requiresCustomerApproval: boolean;
  requiresStaffApproval: boolean;
}

export interface ApprovalRecord {
  approverRole: string;
  status: ApprovalRecordStatus;
}

export type PolicyOutcome = 'approved' | 'rejected' | 'pending';

export interface PolicyEvaluation {
  outcome: PolicyOutcome;
  required: ApproverRole[];
  approved: ApproverRole[];
  rejected: ApproverRole[];
  /** Required roles with no approved record yet. */
  missing: ApproverRole[];
}

/** The first baseline needs both the customer and staff to approve. */
export const BASELINE_BUDGET_POLICY: ApprovalPolicy = {
  requiresCustomerApproval: true,
  requiresStaffApproval: true,
};

/** A policy that requires nobody is not a policy: reject it at creation. */
export function validateApprovalPolicy(policy: ApprovalPolicy): string | null {
  if (!policy.requiresCustomerApproval && !policy.requiresStaffApproval) {
    return 'at least one of customer or staff approval must be required';
  }
  return null;
}

export function requiredApprovers(policy: ApprovalPolicy): ApproverRole[] {
  const roles: ApproverRole[] = [];
  if (policy.requiresCustomerApproval) roles.push('customer');
  if (policy.requiresStaffApproval) roles.push('staff');
  return roles;
}

export function evaluateApprovalPolicy(
  policy: ApprovalPolicy,
  approvals: ApprovalRecord[],
): PolicyEvaluation {
  const required = requiredApprovers(policy);
  const approved: ApproverRole[] = [];
  const rejected: ApproverRole[] = [];
  for (const role of required) {
    const records = approvals.filter((a) => a.approverRole === role);
    // A rejection by a required role is final for this policy evaluation.
    if (records.some((r) => r.status === 'rejected')) rejected.push(role);
    else if (records.some((r) => r.status === 'approved')) approved.push(role);
  }
  const missing = required.filter((r) => !approved.includes(r));
  const outcome: PolicyOutcome =
    rejected.length > 0 ? 'rejected' : missing.length === 0 ? 'approved' : 'pending';
  return { outcome, required, approved, rejected, missing };
}

/**
 * Change-order display state while approvals are outstanding: staff review
 * first while a staff approval is missing, otherwise customer review. Both
 * approvals may be given in either order; the state only says what remains.
 */
export function pendingChangeOrderStatus(
  policy: ApprovalPolicy,
  approvals: ApprovalRecord[],
): 'staff_review' | 'customer_review' {
  const evaluation = evaluateApprovalPolicy(policy, approvals);
  if (evaluation.missing.includes('staff')) return 'staff_review';
  return 'customer_review';
}

/** The new approved total after a change order; a negative budget is rejected. */
export function applyChangeOrderDelta(baseTotalKobo: bigint, deltaKobo: bigint): bigint {
  const total = baseTotalKobo + deltaKobo;
  if (total < 0n) {
    throw new Error(`change order delta ${deltaKobo} would make the budget negative`);
  }
  return total;
}

/** Shifts an ISO calendar date by whole days; null stays null (unknown stays unknown). */
export function shiftIsoDate(isoDate: string | null, days: number): string | null {
  if (isoDate === null) return null;
  if (!Number.isInteger(days)) throw new Error('days must be an integer');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error(`invalid ISO date ${isoDate}`);
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
  return new Date(utc).toISOString().slice(0, 10);
}
