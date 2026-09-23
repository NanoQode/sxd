import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@simplexd/db';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';
import type { RequestIdentity } from '@/lib/auth/session';
import { listPendingApprovals } from './approvals';
import { createBudgetVersion, decideBudgetVersion, getBudgetVariance } from './budgets';
import {
  createChangeOrder,
  decideChangeOrder,
  submitChangeOrder,
  withdrawChangeOrder,
} from './change-orders';
import { createProject, getProjectOverview } from './projects';
import {
  createFixtures,
  customerIdentity,
  errorCode,
  staffIdentity,
  type ProjectFixtures,
} from './testing/fixtures';

/** Acceptance scenario 5: the approved budget cannot change until the required approvals exist. */

let dbs: TestDatabases;
let f: ProjectFixtures;
let admin: RequestIdentity;
let pm: RequestIdentity;
let ops: RequestIdentity;
let ownerA: RequestIdentity;
let memberA: RequestIdentity;
let projectId: string;
let baselineId: string;

async function approvedTotal(): Promise<{ id: string | null; total: bigint | null }> {
  const [p] = await dbs.owner
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  if (!p?.approvedBudgetVersionId) return { id: null, total: null };
  const [v] = await dbs.owner
    .select()
    .from(schema.budgetVersions)
    .where(eq(schema.budgetVersions.id, p.approvedBudgetVersionId));
  return { id: p.approvedBudgetVersionId, total: v!.totalKobo };
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  f = await createFixtures(dbs.owner);
  admin = staffIdentity(f.superAdmin, 'super_admin', true);
  pm = staffIdentity(f.pm, 'project_manager');
  ops = staffIdentity(f.ops, 'operations_manager');
  ownerA = customerIdentity(f, f.ownerA, 'owner');
  memberA = customerIdentity(f, f.memberA, 'member');
  const p = await createProject(admin, {
    organizationId: f.orgA,
    name: 'Change order project',
    kind: 'construction_monitoring',
    pmUserId: f.pm.id,
    targetCompletionDate: '2027-03-01',
  });
  projectId = p.id;
  const draft = await createBudgetVersion(pm, projectId, {
    source: 'manual',
    totalKobo: '100000000',
    contingencyKobo: '5000000',
  });
  await decideBudgetVersion(pm, draft.id, { decision: 'approved' });
  const approved = await decideBudgetVersion(ownerA, draft.id, { decision: 'approved' });
  baselineId = approved.id;
});

afterAll(async () => {
  await dbs.close();
});

describe('change orders and the approved budget', () => {
  it('cannot alter the approved budget until customer and staff approvals are both present', async () => {
    const co = await createChangeOrder(pm, projectId, {
      title: 'Extra retaining wall',
      amountDeltaKobo: '12000000',
      scheduleDeltaDays: 14,
      requiresCustomerApproval: true,
      requiresStaffApproval: true,
    });
    expect(co.status).toBe('draft');
    // No decision is possible before submission.
    expect(
      await errorCode(
        decideChangeOrder(ownerA, co.id, {
          approverRole: 'customer',
          decision: 'approved',
          expectedVersion: 1,
        }),
      ),
    ).toBe('invalid_transition');
    const submitted = await submitChangeOrder(pm, co.id, { expectedVersion: 1 });
    expect(submitted.status).toBe('staff_review');
    expect(submitted.approvals.map((a) => [a.approverRole, a.status]).sort()).toEqual([
      ['customer', 'pending'],
      ['staff', 'pending'],
    ]);
    expect((await approvedTotal()).id).toBe(baselineId);
    // Customer approval alone: still pending, budget untouched.
    expect(
      await errorCode(
        decideChangeOrder(memberA, co.id, {
          approverRole: 'customer',
          decision: 'approved',
          expectedVersion: 2,
        }),
      ),
    ).toMatch(/^forbidden/);
    const afterCustomer = await decideChangeOrder(ownerA, co.id, {
      approverRole: 'customer',
      decision: 'approved',
      expectedVersion: 2,
    });
    expect(afterCustomer.status).toBe('staff_review');
    expect(afterCustomer.approvalPolicy.missing).toEqual(['staff']);
    expect(afterCustomer.appliedBudgetVersionId).toBeNull();
    expect((await approvedTotal()).total).toBe(100_000_000n);
    // The creator cannot give the staff approval; a customer cannot masquerade as staff; ops can.
    expect(
      await errorCode(
        decideChangeOrder(pm, co.id, {
          approverRole: 'staff',
          decision: 'approved',
          expectedVersion: 3,
        }),
      ),
    ).toBe('forbidden');
    expect(
      await errorCode(
        decideChangeOrder(ownerA, co.id, {
          approverRole: 'staff',
          decision: 'approved',
          expectedVersion: 3,
        }),
      ),
    ).toBe('forbidden');
    const pending = await listPendingApprovals(ops);
    expect(pending.actingAs).toEqual(['staff']);
    expect(pending.items.map((i) => i.entityId)).toContain(co.id);
    const varianceBefore = await getBudgetVariance(ownerA, projectId);
    expect(varianceBefore.pendingChangeOrderDeltaKobo).toBe('12000000');
    expect(varianceBefore.approvedTotalKobo).toBe('105000000');
    const approved = await decideChangeOrder(ops, co.id, {
      approverRole: 'staff',
      decision: 'approved',
      expectedVersion: 3,
    });
    expect(approved.status).toBe('approved');
    expect(approved.appliedBudgetVersionId).not.toBeNull();
    const now = await approvedTotal();
    expect(now.id).toBe(approved.appliedBudgetVersionId);
    expect(now.total).toBe(112_000_000n);
    const [superseded] = await dbs.owner
      .select()
      .from(schema.budgetVersions)
      .where(eq(schema.budgetVersions.id, baselineId));
    expect(superseded!.status).toBe('superseded');
    const [applied] = await dbs.owner
      .select()
      .from(schema.budgetVersions)
      .where(eq(schema.budgetVersions.id, approved.appliedBudgetVersionId!));
    expect(applied!.changeOrderId).toBe(co.id);
    expect(applied!.status).toBe('approved');
    // Variance and forecast reflect the approved change.
    const variance = await getBudgetVariance(ownerA, projectId);
    expect(variance.approvedTotalKobo).toBe('117000000');
    expect(variance.approvedChangeOrderDeltaKobo).toBe('12000000');
    expect(variance.pendingChangeOrderDeltaKobo).toBe('0');
    const overview = await getProjectOverview(ownerA, projectId);
    expect(overview.schedule.forecastCompletionDate).toBe('2027-03-15');
    expect(overview.schedule.forecastSource).toBe('change_order_shift');
    expect(overview.changeOrders.approved).toBe(1);
  });

  it('rejects the change order and leaves the budget untouched on any rejection', async () => {
    const before = await approvedTotal();
    const co = await createChangeOrder(pm, projectId, {
      title: 'Gold taps',
      amountDeltaKobo: '4000000',
      scheduleDeltaDays: 0,
      requiresCustomerApproval: true,
      requiresStaffApproval: true,
    });
    await submitChangeOrder(pm, co.id, { expectedVersion: 1 });
    await decideChangeOrder(ops, co.id, {
      approverRole: 'staff',
      decision: 'approved',
      expectedVersion: 2,
    });
    const rejected = await decideChangeOrder(ownerA, co.id, {
      approverRole: 'customer',
      decision: 'rejected',
      note: 'Not in scope',
      expectedVersion: 3,
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.appliedBudgetVersionId).toBeNull();
    expect(await approvedTotal()).toEqual(before);
    expect(
      await errorCode(
        decideChangeOrder(ownerA, co.id, {
          approverRole: 'customer',
          decision: 'approved',
          expectedVersion: 4,
        }),
      ),
    ).toBe('invalid_transition');
  });

  it('applies a staff-only policy with one approval and lets the creator withdraw before any decision', async () => {
    const before = await approvedTotal();
    const co = await createChangeOrder(pm, projectId, {
      title: 'Minor variation',
      amountDeltaKobo: '-1000000',
      scheduleDeltaDays: 0,
      requiresCustomerApproval: false,
      requiresStaffApproval: true,
    });
    const submitted = await submitChangeOrder(pm, co.id, { expectedVersion: 1 });
    expect(submitted.approvals.map((a) => a.approverRole)).toEqual(['staff']);
    expect(
      await errorCode(
        decideChangeOrder(ownerA, co.id, {
          approverRole: 'customer',
          decision: 'approved',
          expectedVersion: 2,
        }),
      ),
    ).toBe('invalid_transition');
    const approved = await decideChangeOrder(ops, co.id, {
      approverRole: 'staff',
      decision: 'approved',
      expectedVersion: 2,
    });
    expect(approved.status).toBe('approved');
    expect((await approvedTotal()).total).toBe(before.total! - 1_000_000n);

    const draft = await createChangeOrder(pm, projectId, {
      title: 'Withdrawn one',
      amountDeltaKobo: '999',
      scheduleDeltaDays: 0,
      requiresCustomerApproval: true,
      requiresStaffApproval: true,
    });
    await submitChangeOrder(pm, draft.id, { expectedVersion: 1 });
    expect(
      await errorCode(
        withdrawChangeOrder(ops, draft.id, { reason: 'not mine', expectedVersion: 2 }),
      ),
    ).toBe('forbidden');
    const withdrawn = await withdrawChangeOrder(pm, draft.id, {
      reason: 'Priced wrongly',
      expectedVersion: 2,
    });
    expect(withdrawn.status).toBe('withdrawn');
    expect(withdrawn.approvals.every((a) => a.status === 'withdrawn')).toBe(true);
    expect(
      await errorCode(
        createChangeOrder(pm, projectId, {
          title: 'No approvers',
          amountDeltaKobo: '1',
          scheduleDeltaDays: 0,
          requiresCustomerApproval: false,
          requiresStaffApproval: false,
        }),
      ),
    ).toBe('validation_failed');
  });
});
