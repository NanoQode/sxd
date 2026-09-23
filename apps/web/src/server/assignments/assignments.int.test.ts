import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema, withActor } from '@simplexd/db';
import { createNote, listNotes } from '@/server/notes/service';
import { createTask, getTask, listTasks } from '@/server/tasks/service';
import { loadAssignmentContext } from './access';
import {
  acceptAssignment,
  activateAssignment,
  completeAssignment,
  declineAssignment,
  getAssignment,
  listAssignments,
  listMyAssignments,
  proposeAssignment,
  revokeAssignment,
} from './service';
import {
  createFixture,
  customerIdentity,
  errorCode,
  opsIdentity,
  partnerIdentity,
  pmIdentity,
  type Fixture,
} from './testing/fixtures';

let f: Fixture;

beforeAll(async () => {
  f = await createFixture();
});

afterAll(async () => {
  await closeDb();
  await f.dbs.close();
});

describe('assignments', () => {
  it('runs propose → accept → activate → complete and notifies through the outbox', async () => {
    const ops = opsIdentity(f);
    const partner = partnerIdentity(f);
    await expect(
      proposeAssignment(customerIdentity(f, 'A'), {
        serviceRequestId: f.serviceRequestA,
        assigneeUserId: f.partner,
        role: 'surveyor',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(
      proposeAssignment(ops, {
        serviceRequestId: f.serviceRequestA,
        assigneeUserId: f.ownerB,
        role: 'surveyor',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    const proposed = await proposeAssignment(ops, {
      serviceRequestId: f.serviceRequestA,
      assigneeUserId: f.partner,
      role: 'surveyor',
      instructions: 'Survey the plot',
    });
    expect(proposed.status).toBe('proposed');
    expect(proposed.organizationId).toBe(f.orgA);
    await expect(
      proposeAssignment(ops, {
        serviceRequestId: f.serviceRequestA,
        assigneeUserId: f.partner,
        role: 'surveyor',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'conflict');

    // Only the assignee answers.
    await expect(acceptAssignment(ops, proposed.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'forbidden',
    );
    const mine = await listMyAssignments(partner, { limit: 25 });
    expect(mine.items.map((a) => a.id)).toContain(proposed.id);
    const accepted = await acceptAssignment(partner, proposed.id);
    expect(accepted.status).toBe('accepted');
    expect(accepted.respondedAt).not.toBeNull();
    await expect(declineAssignment(partner, proposed.id, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'invalid_transition',
    );

    const active = await activateAssignment(ops, proposed.id);
    expect(active.status).toBe('active');
    const completed = await completeAssignment(partner, proposed.id);
    expect(completed.status).toBe('completed');

    const outbox = await f.dbs.owner
      .select({ type: schema.outboxEvents.eventType, payload: schema.outboxEvents.payload })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, proposed.id));
    expect(outbox.map((o) => o.type).sort()).toEqual([
      'assignment.proposed',
      'assignment.responded',
    ]);
    const proposedEvent = outbox.find((o) => o.type === 'assignment.proposed')!.payload as {
      recipientUserIds: string[];
    };
    expect(proposedEvent.recipientUserIds).toEqual([f.partner]);
    const responded = outbox.find((o) => o.type === 'assignment.responded')!.payload as {
      recipientUserIds: string[];
      decision: string;
    };
    expect(responded.decision).toBe('accepted');
    expect(responded.recipientUserIds).toContain(f.ops);
  });

  it('revoking an assignment immediately removes the partner access to the request and its tasks', async () => {
    const ops = opsIdentity(f);
    const partner = partnerIdentity(f);
    const proposed = await proposeAssignment(ops, {
      projectId: f.projectA,
      assigneeUserId: f.partner,
      role: 'inspector',
    });
    await acceptAssignment(partner, proposed.id);
    const task = await createTask(ops, {
      projectId: f.projectA,
      title: 'Inspect footings',
      visibility: 'partner',
      requiresCustomerAction: false,
    });
    const note = await createNote(ops, {
      entityType: 'project',
      entityId: f.projectA,
      body: 'Site opens at 8',
      visibility: 'partner',
    });

    // With an accepted assignment the partner reaches the project's partner-visible work.
    expect(
      (await listTasks(partner, { projectId: f.projectA, limit: 25 })).items.map((t) => t.id),
    ).toEqual([task.id]);
    expect((await getTask(partner, task.id)).id).toBe(task.id);
    expect(
      (
        await listNotes(partner, { entityType: 'project', entityId: f.projectA, limit: 25 })
      ).items.map((n) => n.id),
    ).toEqual([note.id]);
    const ctxBefore = await withActor(f.dbs.app, partner.ctx, (tx) =>
      loadAssignmentContext(tx, { userId: f.partner, projectId: f.projectA }),
    );
    expect(ctxBefore.assignedProjectIds).toContain(f.projectA);
    expect(ctxBefore.assigneeUserIds).toContain(f.partner);

    await expect(revokeAssignment(partner, proposed.id, { reason: 'no' })).rejects.toSatisfy(
      (e) => errorCode(e) === 'forbidden',
    );
    const revoked = await revokeAssignment(ops, proposed.id, { reason: 'Scope reassigned' });
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedAt).not.toBeNull();

    // Fresh transactions: the project row, its tasks and its notes are gone for the partner.
    await expect(listTasks(partner, { projectId: f.projectA, limit: 25 })).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    await expect(getTask(partner, task.id)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    await expect(
      listNotes(partner, { entityType: 'project', entityId: f.projectA, limit: 25 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    const visibleProject = await withActor(f.dbs.app, partner.ctx, (tx) =>
      tx
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.id, f.projectA)),
    );
    expect(visibleProject).toHaveLength(0);
    const ctxAfter = await withActor(f.dbs.app, partner.ctx, (tx) =>
      loadAssignmentContext(tx, {
        userId: f.partner,
        projectId: f.projectA,
        statuses: ['accepted', 'active'],
      }),
    );
    expect(ctxAfter.assignedProjectIds).toEqual([]);
    // The revoked assignment still shows in the partner's own history.
    const mine = await listMyAssignments(partner, { limit: 25, status: 'revoked' });
    expect(mine.items.map((a) => a.id)).toContain(proposed.id);
  });

  it('scopes assignment lists by viewer and keeps project managers to their own work', async () => {
    const ops = opsIdentity(f);
    const proposed = await proposeAssignment(ops, {
      serviceRequestId: f.serviceRequestB,
      assigneeUserId: f.pm,
      role: 'project_manager',
    });
    // A PM not attached to request A cannot staff it.
    await expect(
      proposeAssignment(pmIdentity(f), {
        serviceRequestId: f.serviceRequestA,
        assigneeUserId: f.partner,
        role: 'legal',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await acceptAssignment(pmIdentity(f), proposed.id);
    // Once accepted on request B, the PM can propose there.
    const legal = await proposeAssignment(pmIdentity(f), {
      serviceRequestId: f.serviceRequestB,
      assigneeUserId: f.partner,
      role: 'legal',
    });
    expect(legal.status).toBe('proposed');
    // Customers see accepted work, not proposals.
    const forCustomer = await listAssignments(customerIdentity(f, 'B'), {
      serviceRequestId: f.serviceRequestB,
      limit: 25,
    });
    expect(forCustomer.items.map((a) => a.status)).toEqual(['accepted']);
    await expect(getAssignment(customerIdentity(f, 'B'), legal.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    await expect(
      listAssignments(customerIdentity(f, 'A'), { serviceRequestId: f.serviceRequestB, limit: 25 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    const forStaff = await listAssignments(ops, { serviceRequestId: f.serviceRequestB, limit: 25 });
    expect(forStaff.items).toHaveLength(2);
  });
});
