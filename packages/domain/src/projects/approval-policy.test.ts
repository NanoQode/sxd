import { describe, expect, it } from 'vitest';
import {
  BASELINE_BUDGET_POLICY,
  applyChangeOrderDelta,
  evaluateApprovalPolicy,
  pendingChangeOrderStatus,
  requiredApprovers,
  shiftIsoDate,
  validateApprovalPolicy,
  type ApprovalRecord,
} from './approval-policy';

const approved = (role: string): ApprovalRecord => ({ approverRole: role, status: 'approved' });
const rejected = (role: string): ApprovalRecord => ({ approverRole: role, status: 'rejected' });
const pending = (role: string): ApprovalRecord => ({ approverRole: role, status: 'pending' });

describe('change-order approval policy matrix', () => {
  const both = { requiresCustomerApproval: true, requiresStaffApproval: true };
  const customerOnly = { requiresCustomerApproval: true, requiresStaffApproval: false };
  const staffOnly = { requiresCustomerApproval: false, requiresStaffApproval: true };

  it.each([
    [
      'both required, nothing yet',
      both,
      [pending('customer'), pending('staff')],
      'pending',
      ['customer', 'staff'],
    ],
    [
      'both required, customer only',
      both,
      [approved('customer'), pending('staff')],
      'pending',
      ['staff'],
    ],
    [
      'both required, staff only',
      both,
      [pending('customer'), approved('staff')],
      'pending',
      ['customer'],
    ],
    [
      'both required, both approved',
      both,
      [approved('customer'), approved('staff')],
      'approved',
      [],
    ],
    ['customer only, customer approved', customerOnly, [approved('customer')], 'approved', []],
    [
      'customer only, staff approval is not enough',
      customerOnly,
      [approved('staff')],
      'pending',
      ['customer'],
    ],
    ['staff only, staff approved', staffOnly, [approved('staff')], 'approved', []],
    [
      'both required, customer rejected',
      both,
      [rejected('customer'), approved('staff')],
      'rejected',
      ['customer'],
    ],
    [
      'both required, staff rejected',
      both,
      [approved('customer'), rejected('staff')],
      'rejected',
      ['staff'],
    ],
    [
      'non-required rejection is ignored',
      customerOnly,
      [approved('customer'), rejected('staff')],
      'approved',
      [],
    ],
  ] as const)('%s', (_label, policy, approvals, outcome, missing) => {
    const e = evaluateApprovalPolicy(policy, [...approvals]);
    expect(e.outcome).toBe(outcome);
    expect(e.missing).toEqual([...missing]);
  });

  it('never approves without any approval record', () => {
    expect(evaluateApprovalPolicy(both, []).outcome).toBe('pending');
    expect(evaluateApprovalPolicy(BASELINE_BUDGET_POLICY, []).missing).toEqual([
      'customer',
      'staff',
    ]);
  });

  it('treats a rejection as final even when a later record approves', () => {
    const e = evaluateApprovalPolicy(both, [
      rejected('customer'),
      approved('customer'),
      approved('staff'),
    ]);
    expect(e.outcome).toBe('rejected');
  });

  it('lists the required approvers and rejects an empty policy', () => {
    expect(requiredApprovers(both)).toEqual(['customer', 'staff']);
    expect(requiredApprovers(staffOnly)).toEqual(['staff']);
    expect(
      validateApprovalPolicy({ requiresCustomerApproval: false, requiresStaffApproval: false }),
    ).toMatch(/at least one/);
    expect(validateApprovalPolicy(both)).toBeNull();
  });

  it('shows staff review while staff approval is missing, then customer review', () => {
    expect(pendingChangeOrderStatus(both, [])).toBe('staff_review');
    expect(pendingChangeOrderStatus(both, [approved('staff')])).toBe('customer_review');
    expect(pendingChangeOrderStatus(both, [approved('customer')])).toBe('staff_review');
    expect(pendingChangeOrderStatus(customerOnly, [])).toBe('customer_review');
  });
});

describe('applying a change order', () => {
  it('adds the delta to the base total and refuses a negative budget', () => {
    expect(applyChangeOrderDelta(10_000n, 2_500n)).toBe(12_500n);
    expect(applyChangeOrderDelta(10_000n, -2_500n)).toBe(7_500n);
    expect(() => applyChangeOrderDelta(1_000n, -2_000n)).toThrow(/negative/);
  });

  it('shifts forecast dates by whole days and keeps unknown dates unknown', () => {
    expect(shiftIsoDate('2026-12-30', 5)).toBe('2027-01-04');
    expect(shiftIsoDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftIsoDate(null, 10)).toBeNull();
    expect(() => shiftIsoDate('2026-1-1', 1)).toThrow(/invalid ISO date/);
  });
});
