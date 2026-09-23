import 'server-only';
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type StayBookingCreate,
  type StayBookingDto,
  type StayBookingTransition,
  type StayCalendarQuery,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { assertAllowed, authorizeAny, type ResourceRef } from '@simplexd/domain/authz';
import { nightsBetween, slaDueAt, stayGross, staysOverlap } from '@simplexd/domain/rentals';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { requireProperty } from '@/server/properties/access';
import { FEATURES, ctxFor, requireFlag, requireUserId, type ServiceOptions } from './shared';

/**
 * Short-stay management (`expansion.short_stay`): a per-unit booking
 * calendar with an atomic no-overlap check (a whole-property booking blocks
 * every unit and the reverse), guest check-in/out and a
 * turnover work order raised at check-out. Stay income and costs appear as
 * informational lines on the owner statement; the channel-manager connector
 * is a later integration.
 */

type StayRow = typeof schema.stayBookings.$inferSelect;

function ref(organizationId: string, id?: string): ResourceRef {
  return { type: 'stay_booking', id, organizationId };
}

function assertManage(identity: RequestIdentity, r: ResourceRef): void {
  assertAllowed(
    authorizeAny(identity.actor, [{ staff: 'rentals.manage' }, { org: 'org.leases.manage' }], r),
  );
}

function assertRead(identity: RequestIdentity, r: ResourceRef): void {
  assertAllowed(
    authorizeAny(
      identity.actor,
      [{ staff: 'rentals.manage' }, { staff: 'customers.read' }, { org: 'org.read' }],
      r,
    ),
  );
}

async function toDto(tx: DbExecutor, row: StayRow): Promise<StayBookingDto> {
  const [turnover] = await tx
    .select({ id: schema.workOrders.id })
    .from(schema.workOrders)
    .where(
      and(
        eq(schema.workOrders.category, 'turnover'),
        sql`${schema.workOrders.recurring}->>'stayBookingId' = ${row.id}`,
      ),
    )
    .limit(1);
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    unitId: row.unitId,
    guestName: row.guestName,
    guestContact: (row.guestContact as Record<string, unknown> | null) ?? null,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    nights: row.nights,
    nightlyRateKobo: row.nightlyRateKobo.toString(),
    grossKobo: stayGross(row.nights, row.nightlyRateKobo).toString(),
    platformFeeKobo: row.platformFeeKobo.toString(),
    cleaningKobo: row.cleaningKobo.toString(),
    status: row.status,
    channel: row.channel,
    notes: row.notes,
    turnoverWorkOrderId: turnover?.id ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const BLOCKING: StayRow['status'][] = ['requested', 'confirmed', 'checked_in'];

export async function createStayBooking(
  identity: RequestIdentity,
  input: StayBookingCreate,
  options: ServiceOptions = {},
): Promise<StayBookingDto> {
  requireFlag(identity, FEATURES.shortStay);
  requireUserId(identity);
  const nights = (() => {
    try {
      return nightsBetween(input.checkIn, input.checkOut);
    } catch (err) {
      throw new ApiError('validation_failed', (err as Error).message);
    }
  })();
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const property = await requireProperty(tx, identity, input.propertyId, 'read');
    assertManage(identity, ref(property.organizationId));
    if (input.unitId) {
      const [unit] = await tx
        .select({ id: schema.units.id })
        .from(schema.units)
        .where(and(eq(schema.units.id, input.unitId), eq(schema.units.propertyId, property.id)));
      if (!unit) throw new ApiError('validation_failed', 'unit does not belong to the property');
    }
    // Serialise bookings per property: a whole-property booking (no unit) blocks every unit
    // and a unit booking blocks the whole property.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stay:${property.id}`}))`);
    const existing = await tx
      .select({
        id: schema.stayBookings.id,
        checkIn: schema.stayBookings.checkIn,
        checkOut: schema.stayBookings.checkOut,
      })
      .from(schema.stayBookings)
      .where(
        and(
          eq(schema.stayBookings.propertyId, property.id),
          input.unitId
            ? or(eq(schema.stayBookings.unitId, input.unitId), isNull(schema.stayBookings.unitId))
            : undefined,
          inArray(schema.stayBookings.status, BLOCKING),
        ),
      );
    const clash = existing.find((b) => staysOverlap(b, input));
    if (clash)
      throw new ApiError('slot_unavailable', 'the unit is already booked for part of that stay', {
        details: { bookingId: clash.id },
      });
    const [row] = await tx
      .insert(schema.stayBookings)
      .values({
        organizationId: property.organizationId,
        propertyId: property.id,
        unitId: input.unitId ?? null,
        guestName: input.guestName,
        guestContact: input.guestContact ?? null,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        nights,
        nightlyRateKobo: BigInt(input.nightlyRateKobo),
        platformFeeKobo: BigInt(input.platformFeeKobo),
        cleaningKobo: BigInt(input.cleaningKobo),
        channel: input.channel ?? null,
        notes: input.notes ?? null,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'stay_booking.requested',
      entityType: 'stay_booking',
      entityId: row!.id,
      organizationId: property.organizationId,
      after: {
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        nights,
        unitId: input.unitId ?? null,
      },
      correlationId: options.correlationId,
    });
    return toDto(tx, row!);
  });
}

const TRANSITIONS: Record<StayRow['status'], StayRow['status'][]> = {
  requested: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'cancelled'],
  checked_in: ['checked_out'],
  checked_out: [],
  cancelled: [],
};

export async function transitionStayBooking(
  identity: RequestIdentity,
  id: string,
  input: StayBookingTransition,
  options: ServiceOptions = {},
): Promise<StayBookingDto> {
  requireFlag(identity, FEATURES.shortStay);
  const userId = requireUserId(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.stayBookings)
      .where(eq(schema.stayBookings.id, id))
      .for('update');
    if (!row) throw new ApiError('not_found', 'booking not found');
    assertManage(identity, ref(row.organizationId, row.id));
    if (!TRANSITIONS[row.status].includes(input.to))
      throw new ApiError(
        'invalid_transition',
        `a ${row.status} booking cannot move to ${input.to}`,
      );
    if (input.to === 'cancelled' && !input.reason)
      throw new ApiError('validation_failed', 'a reason is required to cancel');
    const [updated] = await tx
      .update(schema.stayBookings)
      .set({ status: input.to })
      .where(eq(schema.stayBookings.id, id))
      .returning();
    await recordAudit(tx, identity, {
      action: `stay_booking.${input.to}`,
      entityType: 'stay_booking',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status },
      after: { status: input.to },
      reason: input.reason ?? null,
      correlationId: options.correlationId,
    });
    if (input.to === 'checked_out') {
      const now = new Date();
      const [wo] = await tx
        .insert(schema.workOrders)
        .values({
          organizationId: row.organizationId,
          propertyId: row.propertyId,
          unitId: row.unitId,
          reportedByUserId: userId,
          title: `Turnover after ${row.guestName} (${row.checkOut})`,
          description: `Cleaning and inspection after the stay ${row.checkIn} to ${row.checkOut}.`,
          category: 'turnover',
          priority: 'high',
          status: 'requested',
          slaDueAt: slaDueAt('high', now),
          recurring: { stayBookingId: row.id },
        })
        .returning();
      await appendOutbox(tx, {
        eventType: 'work_order.transitioned',
        aggregateType: 'work_order',
        aggregateId: wo!.id,
        organizationId: row.organizationId,
        actorUserId: userId,
        payload: { workOrderId: wo!.id, from: null, to: 'requested', title: wo!.title },
        correlationId: options.correlationId ?? null,
      });
    }
    return toDto(tx, updated!);
  });
}

export async function getStayBooking(
  identity: RequestIdentity,
  id: string,
): Promise<StayBookingDto> {
  requireFlag(identity, FEATURES.shortStay);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const [row] = await tx.select().from(schema.stayBookings).where(eq(schema.stayBookings.id, id));
    if (!row) throw new ApiError('not_found', 'booking not found');
    assertRead(identity, ref(row.organizationId, row.id));
    return toDto(tx, row);
  });
}

/** Bookings touching the window for a property's calendar. */
export async function stayCalendar(
  identity: RequestIdentity,
  query: StayCalendarQuery,
): Promise<StayBookingDto[]> {
  requireFlag(identity, FEATURES.shortStay);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const property = await requireProperty(tx, identity, query.propertyId, 'read');
    assertRead(identity, ref(property.organizationId));
    const rows = await tx
      .select()
      .from(schema.stayBookings)
      .where(
        and(
          eq(schema.stayBookings.propertyId, property.id),
          lte(schema.stayBookings.checkIn, query.to),
          gte(schema.stayBookings.checkOut, query.from),
        ),
      )
      .orderBy(asc(schema.stayBookings.checkIn));
    const out: StayBookingDto[] = [];
    for (const r of rows) out.push(await toDto(tx, r));
    return out;
  });
}
