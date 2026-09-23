import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { acceptAssignment, proposeAssignment } from '@/server/assignments/service';
import {
  createFixture,
  customerIdentity,
  errorCode,
  opsIdentity,
  partnerIdentity,
  type Fixture,
} from '@/server/assignments/testing/fixtures';
import { createNote, listNotes } from './service';

let f: Fixture;

beforeAll(async () => {
  f = await createFixture();
  const proposed = await proposeAssignment(opsIdentity(f), { serviceRequestId: f.serviceRequestA, assigneeUserId: f.partner, role: 'legal' });
  await acceptAssignment(partnerIdentity(f), proposed.id);
});

afterAll(async () => {
  await closeDb();
  await f.dbs.close();
});

describe('notes', () => {
  it('keeps internal notes invisible to the customer organisation that owns the entity', async () => {
    const ops = opsIdentity(f);
    const ownerA = customerIdentity(f, 'A');
    const internal = await createNote(ops, { entityType: 'service_request', entityId: f.serviceRequestA, body: 'Client is difficult', visibility: 'internal' });
    const customer = await createNote(ops, { entityType: 'service_request', entityId: f.serviceRequestA, body: 'Documents received', visibility: 'customer' });
    const partner = await createNote(ops, { entityType: 'service_request', entityId: f.serviceRequestA, body: 'Survey brief', visibility: 'partner' });
    const all = await createNote(ownerA, { entityType: 'service_request', entityId: f.serviceRequestA, body: 'Thanks', visibility: 'all' });

    const customerView = await listNotes(ownerA, { entityType: 'service_request', entityId: f.serviceRequestA, limit: 25 });
    expect(customerView.items.map((n) => n.id).sort()).toEqual([customer.id, all.id].sort());
    expect(customerView.items.some((n) => n.body === 'Client is difficult')).toBe(false);

    const partnerView = await listNotes(partnerIdentity(f), { entityType: 'service_request', entityId: f.serviceRequestA, limit: 25 });
    expect(partnerView.items.map((n) => n.id).sort()).toEqual([partner.id, all.id].sort());

    const staffView = await listNotes(ops, { entityType: 'service_request', entityId: f.serviceRequestA, limit: 25 });
    expect(staffView.items).toHaveLength(4);
    expect(staffView.items.find((n) => n.id === internal.id)?.authorName).toBe(f.ops);
  });

  it('derives write rights from the parent entity', async () => {
    const ownerA = customerIdentity(f, 'A');
    // Customers cannot write internal or partner notes.
    await expect(
      createNote(ownerA, { entityType: 'service_request', entityId: f.serviceRequestA, body: 'x', visibility: 'internal' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    // Another organisation cannot see the entity at all.
    await expect(
      createNote(customerIdentity(f, 'B'), { entityType: 'service_request', entityId: f.serviceRequestA, body: 'x', visibility: 'customer' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    await expect(
      listNotes(customerIdentity(f, 'B'), { entityType: 'service_request', entityId: f.serviceRequestA, limit: 25 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    // A partner may only write partner/all notes on entities they are assigned to.
    const partnerNote = await createNote(partnerIdentity(f), { entityType: 'service_request', entityId: f.serviceRequestA, body: 'On site tomorrow', visibility: 'partner' });
    expect(partnerNote.visibility).toBe('partner');
    await expect(
      createNote(partnerIdentity(f), { entityType: 'service_request', entityId: f.serviceRequestA, body: 'x', visibility: 'customer' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(
      createNote(partnerIdentity(f), { entityType: 'project', entityId: f.projectA, body: 'x', visibility: 'partner' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    // Property notes work for the owning organisation and paginate.
    const [prop] = await f.dbs.owner
      .insert(schema.properties)
      .values({ organizationId: f.orgA, name: 'Noted', kind: 'land' })
      .returning({ id: schema.properties.id });
    await createNote(ownerA, { entityType: 'property', entityId: prop!.id, body: 'first', visibility: 'customer' });
    await createNote(ownerA, { entityType: 'property', entityId: prop!.id, body: 'second', visibility: 'all' });
    const page1 = await listNotes(ownerA, { entityType: 'property', entityId: prop!.id, limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listNotes(ownerA, { entityType: 'property', entityId: prop!.id, limit: 1, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
  });
});
