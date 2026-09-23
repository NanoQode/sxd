import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { connectTestDatabases, type TestDatabases } from '@simplexd/db/testing';
import type { RequestIdentity } from '@/lib/auth/session';
import { acceptAssignment, proposeAssignment } from '@/server/assignments/service';
import { createProject } from '@/server/projects/projects';
import {
  createFixtures,
  customerIdentity,
  errorCode,
  partnerIdentity,
  staffIdentity,
  type ProjectFixtures,
} from '@/server/projects/testing/fixtures';
import { startPartnerConversation } from './partner';
import { getConversation, listConversations } from './service';

/**
 * Partner-started conversations: about the partner's own assignment, with
 * the SimplexD staff on that work (project manager first, operations
 * managers as the fallback) and never the customer.
 */

let dbs: TestDatabases;
let f: ProjectFixtures;
let admin: RequestIdentity;
let ops: RequestIdentity;
let partner: RequestIdentity;
let managedProjectId: string;
let unmanagedProjectId: string;
let otherOrgProjectId: string;

beforeAll(async () => {
  dbs = connectTestDatabases();
  f = await createFixtures(dbs.owner);
  admin = staffIdentity(f.superAdmin, 'super_admin', true);
  ops = staffIdentity(f.ops, 'operations_manager');
  partner = partnerIdentity(f.partner);
  managedProjectId = (
    await createProject(admin, {
      organizationId: f.orgA,
      name: 'Managed build',
      kind: 'construction_monitoring',
      pmUserId: f.pm.id,
    })
  ).id;
  unmanagedProjectId = (
    await createProject(admin, {
      organizationId: f.orgA,
      name: 'Build without a manager',
      kind: 'renovation',
    })
  ).id;
  otherOrgProjectId = (
    await createProject(admin, {
      organizationId: f.orgB,
      name: 'Someone else',
      kind: 'renovation',
    })
  ).id;
  for (const projectId of [managedProjectId, unmanagedProjectId]) {
    const proposed = await proposeAssignment(ops, {
      projectId,
      assigneeUserId: f.partner.id,
      role: 'contractor',
    });
    await acceptAssignment(partner, proposed.id);
  }
});

afterAll(async () => {
  await closeDb();
  await dbs.close();
});

describe('partner conversations', () => {
  it('adds the project manager as the SimplexD side and never the customer', async () => {
    const conversation = await startPartnerConversation(partner, {
      entityType: 'project',
      entityId: managedProjectId,
      subject: 'Access to the site on Saturday',
      message: 'Can the gate be opened at 7am?',
    });
    expect(conversation.kind).toBe('partner');
    expect(conversation.entityId).toBe(managedProjectId);
    expect(conversation.staffParticipantUserIds).toEqual([f.pm.id]);
    const participants = conversation.participants.map((p) => p.userId).sort();
    expect(participants).toEqual([f.partner.id, f.pm.id].sort());
    expect(participants).not.toContain(f.ownerA.id);
    expect(conversation.participants.find((p) => p.userId === f.partner.id)?.role).toBe('owner');
    // Both sides see it; the customer of the organisation does not.
    const pmView = await getConversation(staffIdentity(f.pm, 'project_manager'), conversation.id);
    expect(pmView.participants).toHaveLength(2);
    expect(
      (await listConversations(customerIdentity(f, f.ownerA, 'owner'), { limit: 20, status: 'all' }))
        .items.map((c) => c.id),
    ).not.toContain(conversation.id);
    const [message] = await dbs.owner
      .select({ body: schema.messages.body, sender: schema.messages.senderUserId })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversation.id));
    expect(message).toMatchObject({ body: 'Can the gate be opened at 7am?', sender: f.partner.id });
    const [event] = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.eventType, 'conversation.partner_started'),
          eq(schema.outboxEvents.aggregateId, conversation.id),
        ),
      );
    expect(event?.payload).toMatchObject({
      partnerUserId: f.partner.id,
      recipientUserIds: [f.pm.id],
      entityType: 'project',
    });
  });

  it('falls back to the operations managers when nobody is attached to the work', async () => {
    const conversation = await startPartnerConversation(partner, {
      entityType: 'project',
      entityId: unmanagedProjectId,
      subject: 'Who is my contact?',
      message: 'The project has no manager listed.',
    });
    expect(conversation.staffParticipantUserIds).toContain(f.ops.id);
    expect(conversation.staffParticipantUserIds).not.toContain(f.partner.id);
    expect(conversation.participants.map((p) => p.userId)).not.toContain(f.ownerA.id);
  });

  it('refuses work the partner is not assigned to, and non-partner callers', async () => {
    expect(
      await errorCode(
        startPartnerConversation(partner, {
          entityType: 'project',
          entityId: otherOrgProjectId,
          subject: 'Not mine',
          message: 'Hello?',
        }),
      ),
    ).toMatch(/not_found|forbidden/);
    expect(
      await errorCode(
        startPartnerConversation(customerIdentity(f, f.ownerA, 'owner'), {
          entityType: 'project',
          entityId: managedProjectId,
          subject: 'Customer',
          message: 'Hi',
        }),
      ),
    ).toBe('forbidden');
    expect(
      await errorCode(
        startPartnerConversation(ops, {
          entityType: 'project',
          entityId: managedProjectId,
          subject: 'Staff',
          message: 'Hi',
        }),
      ),
    ).toBe('forbidden');
  });
});
