import { and, eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { customerIdentity, staffIdentity } from '@/testing/identity';
import { viewerFromIdentity } from './access';
import { computeAvailability } from './availability';
import { createBooking } from './book';
import { createHold, lockHold, purgeExpiredHolds } from './holds';
import { cancelAppointment, rescheduleAppointment } from './mutate';
import { getAppointment, getAppointmentByManageToken, listAppointments } from './queries';

/**
 * Appointments: DST-correct availability, expiring holds decided by the
 * exclusion constraint, guest and customer booking, reschedule/cancel and
 * tenant isolation. Google sync is covered in ../calendar/sync.int.test.ts.
 */

let dbs: TestDatabases;
const sfx = uniqueSuffix();
const staffA = `apt_staff_a_${sfx}`;
const staffDst = `apt_staff_dst_${sfx}`;
const opsId = `apt_ops_${sfx}`;
const inspectorId = `apt_inspector_${sfx}`;
const customerA = `apt_cust_a_${sfx}`;
const customerB = `apt_cust_b_${sfx}`;
const orgA = `apt_org_a_${sfx}`;
const orgB = `apt_org_b_${sfx}`;

const ops = () =>
  staffIdentity({ userId: opsId, email: `${opsId}@example.test`, roles: ['operations_manager'] });
const inspector = () =>
  staffIdentity({
    userId: inspectorId,
    email: `${inspectorId}@example.test`,
    roles: ['inspector'],
  });
const custA = () =>
  customerIdentity({ userId: customerA, email: `${customerA}@example.test`, organizationId: orgA });
const custB = () =>
  customerIdentity({ userId: customerB, email: `${customerB}@example.test`, organizationId: orgB });

/** 10:00 Lagos on a day `offset` days ahead (staff A works every day, so weekends are fine). */
function lagosSlot(offsetDays: number, hour = 10, minute = 0): string {
  return DateTime.now()
    .setZone('Africa/Lagos')
    .plus({ days: offsetDays })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!;
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  const owner = dbs.owner;
  await owner.insert(schema.user).values([
    { id: staffA, name: 'Adaeze Organiser', email: `${staffA}@example.test` },
    { id: staffDst, name: 'DST Organiser', email: `${staffDst}@example.test` },
    { id: opsId, name: 'Ops Manager', email: `${opsId}@example.test` },
    { id: inspectorId, name: 'Site Inspector', email: `${inspectorId}@example.test` },
    { id: customerA, name: 'Customer A', email: `${customerA}@example.test` },
    { id: customerB, name: 'Customer B', email: `${customerB}@example.test` },
  ]);
  await owner.insert(schema.staffRoles).values([
    { userId: staffA, role: 'support' },
    { userId: staffDst, role: 'support' },
    { userId: opsId, role: 'operations_manager' },
    { userId: inspectorId, role: 'inspector' },
  ]);
  await owner.insert(schema.organization).values([
    { id: orgA, name: 'Org A', slug: orgA },
    { id: orgB, name: 'Org B', slug: orgB },
  ]);
  await owner.insert(schema.member).values([
    { id: `m_${customerA}`, organizationId: orgA, userId: customerA, role: 'owner' },
    { id: `m_${customerB}`, organizationId: orgB, userId: customerB, role: 'owner' },
  ]);
  // Staff A: every day 09:00–17:00 Lagos, consultations only.
  await owner.insert(schema.staffAvailability).values(
    [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      staffUserId: staffA,
      weekday,
      startTime: '09:00',
      endTime: '17:00',
      timeZone: 'Africa/Lagos',
      kinds: ['consultation'],
    })),
  );
  // DST organiser: weekdays 09:00–12:00 Lagos.
  await owner.insert(schema.staffAvailability).values(
    [1, 2, 3, 4, 5].map((weekday) => ({
      staffUserId: staffDst,
      weekday,
      startTime: '09:00',
      endTime: '12:00',
      timeZone: 'Africa/Lagos',
      kinds: ['consultation'],
    })),
  );
});

afterAll(async () => {
  await dbs.close();
});

describe('availability', () => {
  it('respects working windows and keeps the buffer around existing reservations', async () => {
    const dayStart = lagosSlot(5, 9);
    const busyStart = lagosSlot(5, 10);
    const busyEnd = lagosSlot(5, 10, 30);
    await dbs.owner.insert(schema.slotReservations).values({
      staffUserId: staffA,
      slot: sql`tstzrange(${busyStart}::timestamptz, ${busyEnd}::timestamptz, '[)')` as unknown as string,
      kind: 'block',
      note: 'test block',
    });
    const result = await computeAvailability({
      kind: 'consultation',
      staffUserId: staffA,
      from: new Date(dayStart),
      to: new Date(lagosSlot(5, 17)),
      customerTimeZone: 'Africa/Lagos',
    });
    const starts = result.slots.map((s) =>
      DateTime.fromISO(s.start).setZone('Africa/Lagos').toFormat('HH:mm'),
    );
    expect(result.durationMinutes).toBe(30);
    expect(result.bufferMinutes).toBe(10);
    expect(starts).toContain('09:00');
    expect(starts).not.toContain('09:30'); // ends 10:00, inside the 10-minute buffer before the block
    expect(starts).not.toContain('10:00');
    expect(starts).not.toContain('10:30'); // starts inside the buffer after the block
    expect(starts).toContain('11:00');
    expect(starts).toContain('16:30');
    expect(starts).not.toContain('17:00');
    expect(result.slots.every((s) => s.staffUserId === staffA)).toBe(true);
    expect(result.slots[0]!.label.sameZone).toBe(true);
  });

  it('labels the same Lagos slot correctly for a London customer across the October 2026 DST change', async () => {
    // BST ends on Sunday 25 October 2026. Freeze "now" before the window so
    // notice/horizon rules do not interfere with the DST assertion.
    const now = new Date('2026-10-20T08:00:00Z');
    const result = await computeAvailability({
      kind: 'consultation',
      staffUserId: staffDst,
      from: new Date('2026-10-23T00:00:00Z'),
      to: new Date('2026-10-27T00:00:00Z'),
      customerTimeZone: 'Europe/London',
      now,
    });
    const friday = result.slots.find((s) => s.start === '2026-10-23T08:00:00.000Z');
    const monday = result.slots.find((s) => s.start === '2026-10-26T08:00:00.000Z');
    expect(friday).toBeDefined();
    expect(monday).toBeDefined();
    // Business zone: 09:00 both days (Lagos has no DST).
    expect(friday!.label.business).toMatch(/09:00–09:30 GMT\+1 \(Africa\/Lagos\)/);
    expect(monday!.label.business).toMatch(/09:00–09:30 GMT\+1 \(Africa\/Lagos\)/);
    // Customer zone: 09:00 BST before the change, 08:00 GMT after it.
    expect(friday!.label.customer).toMatch(/09:00–09:30 .*\(Europe\/London\)/);
    expect(friday!.label.customerOffsetMinutes).toBe(60);
    expect(monday!.label.customer).toMatch(/08:00–08:30 .*\(Europe\/London\)/);
    expect(monday!.label.customerOffsetMinutes).toBe(0);
    expect(monday!.label.sameZone).toBe(false);
    // No weekend slots for a weekday-only organiser.
    expect(
      result.slots.some(
        (s) => s.start.startsWith('2026-10-24') || s.start.startsWith('2026-10-25'),
      ),
    ).toBe(false);
  });

  it('reports no_staff_configured for a kind nobody offers', async () => {
    const result = await computeAvailability({
      kind: 'site_visit',
      staffUserId: staffA,
      from: new Date(lagosSlot(3, 9)),
      to: new Date(lagosSlot(3, 17)),
      customerTimeZone: 'Africa/Lagos',
    });
    expect(result.unavailableReason).toBe('no_staff_configured');
    expect(result.slots).toHaveLength(0);
  });
});

describe('holds', () => {
  it('lets exactly one of two concurrent requests hold the same slot', async () => {
    const start = lagosSlot(6, 11);
    const outcomes = await Promise.allSettled([
      createHold(
        { kind: 'consultation', staffUserId: staffA, start, customerTimeZone: 'Africa/Lagos' },
        { identity: null },
      ),
      createHold(
        { kind: 'consultation', staffUserId: staffA, start, customerTimeZone: 'Africa/Lagos' },
        { identity: null },
      ),
    ]);
    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter((o) => o.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'slot_unavailable' });
    const hold = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof createHold>>>).value;
    expect(hold.staffUserId).toBe(staffA);
    expect(hold.end).toBe(DateTime.fromISO(start).plus({ minutes: 30 }).toUTC().toISO());
    // The held slot disappears from availability while the hold is live.
    const availability = await computeAvailability({
      kind: 'consultation',
      staffUserId: staffA,
      from: new Date(lagosSlot(6, 9)),
      to: new Date(lagosSlot(6, 17)),
      customerTimeZone: 'Africa/Lagos',
    });
    expect(availability.slots.some((s) => s.start === hold.start)).toBe(false);
  });

  it('rejects overlapping holds and frees the slot once a hold expires', async () => {
    const start = lagosSlot(7, 14);
    const past = new Date(Date.now() - 60 * 60_000);
    const hold = await createHold(
      { kind: 'consultation', staffUserId: staffA, start, customerTimeZone: 'Africa/Lagos' },
      { identity: null, now: past },
    );
    expect(new Date(hold.expiresAt).getTime()).toBe(past.getTime() + 10 * 60_000);
    await expect(
      createHold(
        {
          kind: 'consultation',
          staffUserId: staffA,
          start: DateTime.fromISO(start).plus({ minutes: 15 }).toUTC().toISO()!,
          customerTimeZone: 'Africa/Lagos',
        },
        { identity: null, now: past },
      ),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });
    // The hold is now expired (expiry was 50 minutes ago): booking it fails, a new hold succeeds.
    await expect(
      dbs.owner.transaction((tx) => lockHold(tx, hold.holdToken, new Date())),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });
    const purged = await dbs.owner.transaction((tx) => purgeExpiredHolds(tx, new Date()));
    expect(purged).toBeGreaterThanOrEqual(1);
    const again = await createHold(
      { kind: 'consultation', staffUserId: staffA, start, customerTimeZone: 'Africa/Lagos' },
      { identity: null },
    );
    expect(again.start).toBe(hold.start);
  });

  it('refuses anonymous holds for kinds that need an account and past times', async () => {
    await expect(
      createHold(
        {
          kind: 'site_visit',
          staffUserId: staffA,
          start: lagosSlot(4, 10),
          customerTimeZone: 'Africa/Lagos',
        },
        { identity: null },
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(
      createHold(
        {
          kind: 'consultation',
          staffUserId: staffA,
          start: lagosSlot(-1, 10),
          customerTimeZone: 'Africa/Lagos',
        },
        { identity: null },
      ),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });
  });
});

describe('booking, manage token and isolation', () => {
  let guestAppointmentId: string;
  let manageToken: string;
  let orgAppointmentId: string;

  it('books a guest consultation from a hold and queues the calendar sync', async () => {
    const hold = await createHold(
      {
        kind: 'consultation',
        staffUserId: staffA,
        start: lagosSlot(8, 9),
        customerTimeZone: 'Europe/London',
      },
      { identity: null },
    );
    const appointment = await createBooking(
      {
        holdToken: hold.holdToken,
        guest: {
          name: 'Ngozi Guest',
          email: `ngozi_${sfx}@example.test`,
          phoneE164: '+2348012345678',
        },
        customerTimeZone: 'Europe/London',
        topic: 'Buying in Ibadan',
      },
      { identity: null, correlationId: `book-${sfx}` },
    );
    guestAppointmentId = appointment.id;
    expect(appointment.status).toBe('confirmed');
    expect(appointment.kind).toBe('consultation');
    expect(appointment.staff).toEqual({ id: staffA, name: 'Adaeze Organiser' });
    expect(appointment.calendarSyncStatus).toBe('pending');
    expect(appointment.conferenceStatus).toBe('pending');
    expect(appointment.meetingUrl).toBeNull();
    expect(appointment.meetingProvider).toBe('google_meet');
    expect(appointment.managePath).toMatch(/^\/api\/v1\/appointments\/manage\//);
    expect(appointment.icsPath).toContain(`/api/v1/appointments/${appointment.id}/ics?token=`);
    expect(appointment.label.customer).toContain('(Europe/London)');
    manageToken = decodeURIComponent(appointment.managePath!.split('/').pop()!);

    const [reservation] = await dbs.owner
      .select()
      .from(schema.slotReservations)
      .where(eq(schema.slotReservations.appointmentId, appointment.id));
    expect(reservation).toMatchObject({ kind: 'appointment', holdToken: null, expiresAt: null });
    const jobs = await dbs.owner
      .select()
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.type, 'calendar.sync_event'),
          sql`${schema.jobs.payload}->>'appointmentId' = ${appointment.id}`,
        ),
      );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.queue).toBe('calendar');
    const outbox = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.aggregateId, appointment.id),
          eq(schema.outboxEvents.eventType, 'appointment.booked'),
        ),
      );
    expect(outbox).toHaveLength(1);
    const [sync] = await dbs.owner
      .select()
      .from(schema.eventSyncs)
      .where(eq(schema.eventSyncs.appointmentId, appointment.id));
    expect(sync).toMatchObject({ status: 'pending', conferenceStatus: 'pending', syncVersion: 0 });
    expect(sync!.conferenceRequestId).toHaveLength(36);
    // A consumed hold cannot be booked twice.
    await expect(
      createBooking(
        {
          holdToken: hold.holdToken,
          guest: { name: 'Ngozi Guest', email: 'x@example.test', phoneE164: '+2348012345678' },
          customerTimeZone: 'Africa/Lagos',
        },
        { identity: null, correlationId: 'dup' },
      ),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });
  });

  it('serves the guest through the manage token and rejects other tokens', async () => {
    const viaToken = await getAppointmentByManageToken(manageToken);
    expect(viaToken.id).toBe(guestAppointmentId);
    expect(viaToken.managePath).not.toBeNull();
    expect(viaToken.sync).toBeNull();
    await expect(getAppointmentByManageToken(`${manageToken}x`)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      cancelAppointment(
        { kind: 'token', manageToken: `${manageToken}x` },
        { reason: 'nope' },
        { correlationId: 'c' },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lets a guest reschedule onto a fresh hold with an atomic reservation swap', async () => {
    const before = await getAppointmentByManageToken(manageToken);
    const hold = await createHold(
      {
        kind: 'consultation',
        staffUserId: staffA,
        start: lagosSlot(9, 15),
        customerTimeZone: 'Europe/London',
      },
      { identity: null },
    );
    const after = await rescheduleAppointment(
      { kind: 'token', manageToken },
      { holdToken: hold.holdToken, reason: 'flight moved' },
      { correlationId: 'resched' },
    );
    expect(after.startsAt).toBe(hold.start);
    expect(after.status).toBe('rescheduled');
    expect(after.version).toBe(before.version + 1);
    expect(after.calendarSyncStatus).toBe('pending');
    const reservations = await dbs.owner
      .select()
      .from(schema.slotReservations)
      .where(eq(schema.slotReservations.appointmentId, guestAppointmentId));
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.kind).toBe('appointment');
    const oldSlotFree = await computeAvailability({
      kind: 'consultation',
      staffUserId: staffA,
      from: new Date(lagosSlot(8, 9)),
      to: new Date(lagosSlot(8, 10)),
      customerTimeZone: 'Africa/Lagos',
    });
    expect(oldSlotFree.slots.some((s) => s.start === before.startsAt)).toBe(true);
    const [sync] = await dbs.owner
      .select()
      .from(schema.eventSyncs)
      .where(eq(schema.eventSyncs.appointmentId, guestAppointmentId));
    expect(sync!.syncVersion).toBe(1);
    const jobs = await dbs.owner
      .select()
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.type, 'calendar.sync_event'),
          sql`${schema.jobs.payload}->>'appointmentId' = ${guestAppointmentId}`,
        ),
      );
    expect(jobs).toHaveLength(2);
  });

  it('links a signed-in customer to their organisation and isolates other organisations', async () => {
    const hold = await createHold(
      {
        kind: 'consultation',
        staffUserId: staffA,
        start: lagosSlot(10, 9),
        customerTimeZone: 'Africa/Lagos',
      },
      { identity: custA() },
    );
    const appointment = await createBooking(
      {
        holdToken: hold.holdToken,
        customerTimeZone: 'Africa/Lagos',
        guest: { name: 'ignored', email: 'ignored@example.test', phoneE164: '+2348000000000' },
      },
      { identity: custA(), correlationId: 'org-book' },
    );
    orgAppointmentId = appointment.id;
    expect(appointment.organizationId).toBe(orgA);
    expect(appointment.customerUserId).toBe(customerA);
    expect(appointment.contact?.email).toBe(`${customerA}@example.test`);

    // Owner sees it; a different organisation does not; the organiser and manage_all staff do; an unrelated inspector does not.
    expect((await getAppointment(viewerFromIdentity(custA()), orgAppointmentId)).id).toBe(
      orgAppointmentId,
    );
    await expect(
      getAppointment(viewerFromIdentity(custB()), orgAppointmentId),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      getAppointment(viewerFromIdentity(inspector()), orgAppointmentId),
    ).rejects.toMatchObject({ code: 'not_found' });
    const staffView = await getAppointment(viewerFromIdentity(ops()), orgAppointmentId);
    expect(staffView.sync).not.toBeNull();
    expect(staffView.managePath).toBeNull();
    const organiserView = await getAppointment(
      viewerFromIdentity(
        staffIdentity({ userId: staffA, email: `${staffA}@example.test`, roles: ['support'] }),
      ),
      orgAppointmentId,
    );
    expect(organiserView.id).toBe(orgAppointmentId);

    const listB = await listAppointments(viewerFromIdentity(custB()), { limit: 25, scope: 'all' });
    expect(listB.items.some((a) => a.id === orgAppointmentId)).toBe(false);
    const listA = await listAppointments(viewerFromIdentity(custA()), { limit: 25, scope: 'all' });
    expect(listA.items.map((a) => a.id)).toContain(orgAppointmentId);
    const mine = await listAppointments(viewerFromIdentity(ops()), { limit: 25, scope: 'mine' });
    expect(mine.items.some((a) => a.id === orgAppointmentId)).toBe(false);
    const all = await listAppointments(viewerFromIdentity(ops()), {
      limit: 100,
      scope: 'all',
      staffUserId: staffA,
    });
    expect(all.items.map((a) => a.id)).toContain(orgAppointmentId);
  });

  it('enforces the notice policy for customers but lets staff cancel late with a reason', async () => {
    await dbs.owner
      .update(schema.appointments)
      .set({
        startsAt: new Date(Date.now() + 2 * 3600_000),
        endsAt: new Date(Date.now() + 2.5 * 3600_000),
      })
      .where(eq(schema.appointments.id, orgAppointmentId));
    await expect(
      cancelAppointment(
        { kind: 'id', viewer: viewerFromIdentity(custA()), id: orgAppointmentId },
        { reason: 'too late' },
        { correlationId: 'c' },
      ),
    ).rejects.toMatchObject({ code: 'deadline_passed' });
    await expect(
      cancelAppointment(
        { kind: 'id', viewer: viewerFromIdentity(custB()), id: orgAppointmentId },
        { reason: 'not mine' },
        { correlationId: 'c' },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    const cancelled = await cancelAppointment(
      { kind: 'id', viewer: viewerFromIdentity(ops()), id: orgAppointmentId },
      { reason: 'organiser unavailable' },
      { correlationId: 'cancel' },
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellationReason).toBe('organiser unavailable');
    expect(cancelled.canCancel).toBe(false);
    // Capacity released; no provider event existed yet so the sync is simply closed.
    const reservations = await dbs.owner
      .select()
      .from(schema.slotReservations)
      .where(eq(schema.slotReservations.appointmentId, orgAppointmentId));
    expect(reservations).toHaveLength(0);
    expect(cancelled.calendarSyncStatus).toBe('cancelled');
    await expect(
      cancelAppointment(
        { kind: 'id', viewer: viewerFromIdentity(ops()), id: orgAppointmentId },
        { reason: 'again' },
        { correlationId: 'c' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    const audit = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.entityId, orgAppointmentId),
          eq(schema.auditEvents.action, 'appointment.cancelled'),
        ),
      );
    expect(audit).toHaveLength(1);
  });
});
