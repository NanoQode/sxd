import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { customerIdentity, staffIdentity } from '@/testing/identity';
import type { RequestIdentity } from '@/lib/auth/session';
import { computeAvailability } from './availability';
import {
  addTimeOff,
  getStaffAvailability,
  removeTimeOff,
  replaceStaffAvailability,
} from './staff-availability';

describe('staff availability', () => {
  let dbs: TestDatabases;
  const s = uniqueSuffix();
  const ops = { id: `ops_${s}`, email: `ops_${s}@example.test` };
  const pm = { id: `pm_${s}`, email: `pm_${s}@example.test` };
  const inspector = { id: `insp_${s}`, email: `insp_${s}@example.test` };
  const partner = { id: `partner_${s}`, email: `partner_${s}@example.test` };
  const customer = { id: `cust_${s}`, email: `cust_${s}@example.test` };

  let opsIdentity: RequestIdentity;
  let pmIdentity: RequestIdentity;
  let inspectorIdentity: RequestIdentity;
  let partnerIdentity: RequestIdentity;
  let customerIdentityValue: RequestIdentity;

  beforeAll(async () => {
    dbs = connectTestDatabases();
    for (const u of [ops, pm, inspector, partner, customer]) {
      await dbs.owner
        .insert(schema.user)
        .values({ id: u.id, name: u.id, email: u.email, emailVerified: true });
    }
    await dbs.owner.insert(schema.staffRoles).values([
      { userId: ops.id, role: 'operations_manager' },
      { userId: pm.id, role: 'project_manager' },
      { userId: inspector.id, role: 'inspector' },
    ]);
    await dbs.owner.insert(schema.partnerProfiles).values({
      userId: partner.id,
      displayName: 'Survey partner',
      partnerType: 'surveyor',
    } as typeof schema.partnerProfiles.$inferInsert);
    opsIdentity = staffIdentity({
      userId: ops.id,
      email: ops.email,
      roles: ['operations_manager'],
    });
    pmIdentity = staffIdentity({ userId: pm.id, email: pm.email, roles: ['project_manager'] });
    inspectorIdentity = staffIdentity({
      userId: inspector.id,
      email: inspector.email,
      roles: ['inspector'],
    });
    partnerIdentity = customerIdentity({
      userId: partner.id,
      email: partner.email,
      organizationId: null,
    });
    partnerIdentity.actor.isPartner = true;
    customerIdentityValue = customerIdentity({
      userId: customer.id,
      email: customer.email,
      organizationId: null,
    });
  });

  afterAll(async () => {
    await dbs.close();
    await closeDb();
  });

  it('lets staff set their own windows and makes the booking engine offer slots', async () => {
    const result = await replaceStaffAvailability(pmIdentity, pm.id, {
      windows: [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        start: '09:00',
        end: '12:00',
        timeZone: 'Africa/Lagos',
        kinds: [],
      })),
    });
    expect(result.windows).toHaveLength(5);
    const from = DateTime.now().setZone('Africa/Lagos').plus({ days: 3 }).startOf('day');
    const availability = await computeAvailability({
      kind: 'consultation',
      staffUserId: pm.id,
      from: from.toJSDate(),
      to: from.plus({ days: 7 }).toJSDate(),
      customerTimeZone: 'Europe/London',
    });
    expect(availability.slots.length).toBeGreaterThan(0);
    for (const slot of availability.slots) {
      const local = DateTime.fromISO(slot.start).setZone('Africa/Lagos');
      expect(local.weekday).toBeLessThanOrEqual(5);
      expect(local.hour).toBeGreaterThanOrEqual(9);
      expect(local.hour).toBeLessThan(12);
    }
  });

  it('refuses edits to someone else unless the caller manages all appointments', async () => {
    // Inspectors hold no appointments.manage_all; project managers and operations do.
    await expect(
      replaceStaffAvailability(inspectorIdentity, ops.id, { windows: [] }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const own = await replaceStaffAvailability(inspectorIdentity, inspector.id, {
      windows: [{ weekday: 3, start: '13:00', end: '15:00', timeZone: 'Africa/Lagos', kinds: [] }],
    });
    expect(own.windows).toHaveLength(1);
    const byOps = await replaceStaffAvailability(opsIdentity, pm.id, {
      windows: [{ weekday: 6, start: '10:00', end: '11:00', timeZone: 'Africa/Lagos', kinds: [] }],
    });
    expect(byOps.windows).toEqual([
      { weekday: 6, start: '10:00', end: '11:00', timeZone: 'Africa/Lagos', kinds: [] },
    ]);
  });

  it('lets a partner manage their own availability but not a customer', async () => {
    const own = await replaceStaffAvailability(partnerIdentity, partner.id, {
      windows: [{ weekday: 2, start: '08:00', end: '10:00', timeZone: 'Africa/Lagos', kinds: [] }],
    });
    expect(own.windows).toHaveLength(1);
    // A customer is neither staff nor partner: the partner authorization refuses
    // (AuthorizationError, mapped to 403 by the route layer).
    await expect(
      replaceStaffAvailability(customerIdentityValue, customer.id, { windows: [] }),
    ).rejects.toMatchObject({ decision: { allowed: false, code: 'no_permission' } });
    await expect(getStaffAvailability(customerIdentityValue, pm.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('records time off, rejects overlapping periods and removes entries', async () => {
    const start = DateTime.now().plus({ days: 10 }).startOf('hour');
    const withLeave = await addTimeOff(pmIdentity, pm.id, {
      kind: 'leave',
      startsAt: start.toUTC().toISO()!,
      endsAt: start.plus({ days: 2 }).toUTC().toISO()!,
      note: 'Annual leave',
    });
    expect(withLeave.timeOff).toHaveLength(1);
    await expect(
      addTimeOff(pmIdentity, pm.id, {
        kind: 'block',
        startsAt: start.plus({ hours: 5 }).toUTC().toISO()!,
        endsAt: start.plus({ hours: 6 }).toUTC().toISO()!,
      }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });
    const after = await removeTimeOff(pmIdentity, pm.id, withLeave.timeOff[0]!.id);
    expect(after.timeOff).toHaveLength(0);
  });

  it('rejects windows whose start is not before the end', async () => {
    await expect(
      replaceStaffAvailability(pmIdentity, pm.id, {
        windows: [
          { weekday: 1, start: '12:00', end: '09:00', timeZone: 'Africa/Lagos', kinds: [] },
        ],
      }),
    ).rejects.toThrow();
  });
});
