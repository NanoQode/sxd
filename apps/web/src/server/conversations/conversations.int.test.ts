import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { acceptAssignment, proposeAssignment } from '@/server/assignments/service';
import {
  createFixture,
  customerIdentity,
  errorCode,
  insertFile,
  opsIdentity,
  partnerIdentity,
  supportIdentity,
  type Fixture,
} from '@/server/assignments/testing/fixtures';
import { listMessages, postMessage } from './messages';
import {
  addParticipant,
  closeConversation,
  createConversation,
  getConversation,
  listConversations,
  markConversationRead,
  removeParticipant,
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

describe('conversations', () => {
  it('isolates conversations to participants and hides internal-only messages from customers', async () => {
    const ownerA = customerIdentity(f, 'A');
    const ops = opsIdentity(f);
    // Participants must already have access to the linked request: org B's owner may not join.
    await expect(
      createConversation(ownerA, {
        kind: 'customer_team',
        subject: 'Diligence',
        entityType: 'service_request',
        entityId: f.serviceRequestA,
        participantUserIds: [f.ownerB],
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    const conv = await createConversation(ownerA, {
      kind: 'customer_team',
      subject: 'Diligence questions',
      entityType: 'service_request',
      entityId: f.serviceRequestA,
      participantUserIds: [f.ops, f.partner],
      initialMessage: 'Hello team',
    });
    expect(conv.participants.map((p) => p.userId).sort()).toEqual(
      [f.ops, f.ownerA, f.partner].sort(),
    );
    expect(conv.lastMessageAt).not.toBeNull();

    // Non-participants get not_found even with the id: org B, and support (no messages.read_all).
    await expect(getConversation(customerIdentity(f, 'B'), conv.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    await expect(listMessages(customerIdentity(f, 'B'), conv.id, { limit: 25 })).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    await expect(
      postMessage(customerIdentity(f, 'B'), conv.id, {
        body: 'hi',
        attachmentFileIds: [],
        internalOnly: false,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    await expect(getConversation(supportIdentity(f), conv.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    // An adviser of org A who is not a participant is also not_found (row-level security hides the row).
    await expect(getConversation(customerIdentity(f, 'A', 'adviser'), conv.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );

    await postMessage(ops, conv.id, {
      body: 'Internal: waiting on legal',
      attachmentFileIds: [],
      internalOnly: true,
    });
    await postMessage(partnerIdentity(f), conv.id, {
      body: 'Survey booked',
      attachmentFileIds: [],
      internalOnly: false,
    });
    await expect(
      postMessage(ownerA, conv.id, { body: 'x', attachmentFileIds: [], internalOnly: true }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');

    const customerMessages = await listMessages(ownerA, conv.id, { limit: 25 });
    expect(customerMessages.items.map((m) => m.body)).toEqual(['Survey booked', 'Hello team']);
    const staffMessages = await listMessages(ops, conv.id, { limit: 25 });
    expect(staffMessages.items.map((m) => m.body)).toEqual([
      'Survey booked',
      'Internal: waiting on legal',
      'Hello team',
    ]);
    const page1 = await listMessages(ownerA, conv.id, { limit: 1 });
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listMessages(ownerA, conv.id, { limit: 1, cursor: page1.nextCursor! });
    expect(page2.items.map((m) => m.body)).toEqual(['Hello team']);

    const outbox = await f.dbs.owner
      .select({ payload: schema.outboxEvents.payload })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, 'message.posted'));
    for (const o of outbox) expect(Object.keys(o.payload as object)).not.toContain('body');
    const internalEvent = outbox
      .map((o) => o.payload as { internalOnly: boolean; recipientUserIds: string[] })
      .find((p) => p.internalOnly)!;
    expect(internalEvent.recipientUserIds).toEqual([]);
  });

  it('tracks read state, manages participants and closes', async () => {
    const ownerA = customerIdentity(f, 'A');
    const conv = await createConversation(ownerA, {
      kind: 'customer_team',
      subject: 'General',
      participantUserIds: [f.ops],
    });
    await postMessage(opsIdentity(f), conv.id, {
      body: 'Welcome',
      attachmentFileIds: [],
      internalOnly: false,
    });
    const before = await listConversations(ownerA, { limit: 25, status: 'open' });
    expect(before.items.find((c) => c.id === conv.id)?.unreadCount).toBe(1);
    await markConversationRead(ownerA, conv.id);
    expect((await getConversation(ownerA, conv.id)).unreadCount).toBe(0);

    // Only staff or the creator manage participants; the adviser of org A may be added.
    await expect(
      addParticipant(partnerIdentity(f), conv.id, { userId: f.adviserA }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    const withAdviser = await addParticipant(ownerA, conv.id, { userId: f.adviserA });
    expect(withAdviser.participants.map((p) => p.userId)).toContain(f.adviserA);
    await expect(addParticipant(ownerA, conv.id, { userId: f.ownerB })).rejects.toSatisfy(
      (e) => errorCode(e) === 'validation_failed',
    );
    // An adviser can read and post (org.messages.send) but not remove others.
    expect(
      (await listMessages(customerIdentity(f, 'A', 'adviser'), conv.id, { limit: 25 })).items,
    ).toHaveLength(1);
    await expect(
      removeParticipant(customerIdentity(f, 'A', 'adviser'), conv.id, f.ops),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    const left = await removeParticipant(ownerA, conv.id, f.adviserA);
    expect(left.participants.find((p) => p.userId === f.adviserA)?.leftAt).not.toBeNull();
    await expect(getConversation(customerIdentity(f, 'A', 'adviser'), conv.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );

    // Attachments must be files the sender can access and that are usable.
    const infected = await insertFile(f.dbs.owner, f.orgA, f.ownerA, 'infected');
    await expect(
      postMessage(ownerA, conv.id, {
        body: 'see attached',
        attachmentFileIds: [infected],
        internalOnly: false,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'file_quarantined');
    const foreign = await insertFile(f.dbs.owner, f.orgB, f.ownerB);
    await expect(
      postMessage(ownerA, conv.id, {
        body: 'see attached',
        attachmentFileIds: [foreign],
        internalOnly: false,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    const clean = await insertFile(f.dbs.owner, f.orgA, f.ownerA);
    const withFile = await postMessage(ownerA, conv.id, {
      body: 'see attached',
      attachmentFileIds: [clean],
      internalOnly: false,
    });
    expect(withFile.attachmentFileIds).toEqual([clean]);

    const closed = await closeConversation(ownerA, conv.id);
    expect(closed.closedAt).not.toBeNull();
    await expect(
      postMessage(ownerA, conv.id, { body: 'late', attachmentFileIds: [], internalOnly: false }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'invalid_transition');
    expect(
      (await listConversations(ownerA, { limit: 25, status: 'open' })).items.map((c) => c.id),
    ).not.toContain(conv.id);
    // Internal conversations are staff only.
    await expect(
      createConversation(ownerA, { kind: 'internal', subject: 'x', participantUserIds: [f.ops] }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(
      createConversation(opsIdentity(f), {
        kind: 'internal',
        subject: 'x',
        participantUserIds: [f.ownerA],
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
  });
});
