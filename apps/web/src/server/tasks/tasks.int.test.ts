import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { acceptAssignment, proposeAssignment } from '@/server/assignments/service';
import {
  createFixture,
  customerIdentity,
  errorCode,
  opsIdentity,
  partnerIdentity,
  supportIdentity,
  type Fixture,
} from '@/server/assignments/testing/fixtures';
import {
  assignTask,
  blockTask,
  cancelTask,
  completeTask,
  createTask,
  listMyTasks,
  listTasks,
  unblockTask,
} from './service';

let f: Fixture;

beforeAll(async () => {
  f = await createFixture();
  const proposed = await proposeAssignment(opsIdentity(f), {
    serviceRequestId: f.serviceRequestA,
    assigneeUserId: f.partner,
    role: 'surveyor',
  });
  await acceptAssignment(partnerIdentity(f), proposed.id);
});

afterAll(async () => {
  await closeDb();
  await f.dbs.close();
});

describe('task visibility matrix', () => {
  it('hides internal tasks from customers and partners, and customer tasks from partners', async () => {
    const ops = opsIdentity(f);
    const internal = await createTask(ops, {
      serviceRequestId: f.serviceRequestA,
      title: 'Internal check',
      visibility: 'internal',
      requiresCustomerAction: false,
    });
    const customer = await createTask(ops, {
      serviceRequestId: f.serviceRequestA,
      title: 'Upload deed',
      visibility: 'customer',
      requiresCustomerAction: true,
    });
    const partner = await createTask(ops, {
      serviceRequestId: f.serviceRequestA,
      title: 'Survey',
      visibility: 'partner',
      requiresCustomerAction: false,
    });
    const everyone = await createTask(ops, {
      serviceRequestId: f.serviceRequestA,
      title: 'Kick-off',
      visibility: 'all',
      requiresCustomerAction: false,
    });

    const staffView = await listTasks(ops, { serviceRequestId: f.serviceRequestA, limit: 25 });
    expect(staffView.items.map((t) => t.id).sort()).toEqual(
      [internal.id, customer.id, partner.id, everyone.id].sort(),
    );

    const customerView = await listTasks(customerIdentity(f, 'A'), {
      serviceRequestId: f.serviceRequestA,
      limit: 25,
    });
    expect(customerView.items.map((t) => t.id).sort()).toEqual([customer.id, everyone.id].sort());

    const partnerView = await listTasks(partnerIdentity(f), {
      serviceRequestId: f.serviceRequestA,
      limit: 25,
    });
    expect(partnerView.items.map((t) => t.id).sort()).toEqual([partner.id, everyone.id].sort());

    await expect(
      listTasks(customerIdentity(f, 'B'), { serviceRequestId: f.serviceRequestA, limit: 25 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    // Support holds no service_requests permission and no assignment.
    await expect(
      listTasks(supportIdentity(f), { serviceRequestId: f.serviceRequestA, limit: 25 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    // Customers cannot create tasks; internal tasks cannot go to partners.
    await expect(
      createTask(customerIdentity(f, 'A'), {
        serviceRequestId: f.serviceRequestA,
        title: 'x',
        visibility: 'customer',
        requiresCustomerAction: false,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(
      createTask(ops, {
        serviceRequestId: f.serviceRequestA,
        title: 'x',
        visibility: 'internal',
        requiresCustomerAction: false,
        assigneeUserId: f.partner,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
  });

  it('surfaces customer-action tasks in "my tasks" and lets the right people complete them', async () => {
    const ops = opsIdentity(f);
    const ownerA = customerIdentity(f, 'A');
    const action = await createTask(ops, {
      projectId: f.projectA,
      title: 'Approve budget',
      visibility: 'customer',
      requiresCustomerAction: true,
    });
    const staffOnly = await createTask(ops, {
      projectId: f.projectA,
      title: 'Draft report',
      visibility: 'internal',
      requiresCustomerAction: false,
      assigneeUserId: f.ops,
    });

    const mine = await listMyTasks(ownerA, { limit: 25 });
    expect(mine.items.map((t) => t.id)).toContain(action.id);
    expect(mine.items.map((t) => t.id)).not.toContain(staffOnly.id);
    const opsMine = await listMyTasks(ops, { limit: 25 });
    expect(opsMine.items.map((t) => t.id)).toEqual([staffOnly.id]);

    // Advisers can see but not act; org B cannot see at all.
    await expect(completeTask(customerIdentity(f, 'A', 'adviser'), action.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'forbidden',
    );
    await expect(completeTask(customerIdentity(f, 'B'), action.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    const done = await completeTask(ownerA, action.id, { note: 'approved' });
    expect(done.status).toBe('done');
    expect(done.completedBy).toBe(f.ownerA);
    expect((await listMyTasks(ownerA, { limit: 25 })).items.map((t) => t.id)).not.toContain(
      action.id,
    );
    const outbox = await f.dbs.owner
      .select({ type: schema.outboxEvents.eventType, payload: schema.outboxEvents.payload })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, action.id));
    expect(outbox.map((o) => o.type).sort()).toEqual(['task.assigned', 'task.completed']);
    expect((outbox[0]!.payload as Record<string, unknown>)['title']).toBeUndefined();
  });

  it('assigns, blocks, unblocks and cancels with audit trail', async () => {
    const ops = opsIdentity(f);
    const partner = partnerIdentity(f);
    const task = await createTask(ops, {
      serviceRequestId: f.serviceRequestA,
      title: 'Measure boundary',
      visibility: 'partner',
      requiresCustomerAction: false,
    });
    await expect(assignTask(ops, task.id, { assigneeUserId: f.ownerB })).rejects.toSatisfy(
      (e) => errorCode(e) === 'validation_failed',
    );
    const assigned = await assignTask(ops, task.id, { assigneeUserId: f.partner });
    expect(assigned.assigneeUserId).toBe(f.partner);
    const blocked = await blockTask(partner, task.id, { reason: 'Site flooded' });
    expect(blocked.status).toBe('blocked');
    await expect(completeTask(partner, task.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'invalid_transition',
    );
    expect((await unblockTask(partner, task.id, {})).status).toBe('todo');
    await expect(cancelTask(partner, task.id, { reason: 'x' })).rejects.toSatisfy(
      (e) => errorCode(e) === 'forbidden',
    );
    expect((await cancelTask(ops, task.id, { reason: 'Scope removed' })).status).toBe('cancelled');
    const audits = await f.dbs.owner
      .select({ action: schema.auditEvents.action, reason: schema.auditEvents.reason })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, task.id));
    expect(audits.map((a) => a.action)).toEqual([
      'task.created',
      'task.assigned',
      'task.blocked',
      'task.unblocked',
      'task.cancelled',
    ]);
    expect(audits.find((a) => a.action === 'task.blocked')?.reason).toBe('Site flooded');
  });
});
