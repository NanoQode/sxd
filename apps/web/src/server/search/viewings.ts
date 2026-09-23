import 'server-only';
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import {
  ApiError,
  type ViewingDto,
  type ViewingFeedback,
  type ViewingRequest,
  type ViewingUpdate,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  assertUpdatedAt,
  ctxFor,
  notFound,
  userIdOf,
  type ServiceOptions,
} from '@/server/projects/shared';
import {
  assertRequestOpen,
  requireCustomer,
  requireCustomerOrStaff,
  requireStaffManage,
  requireWorkspace,
  type WorkspaceAccess,
} from './access';
import { loadPublishedListings } from './listings';

/**
 * Viewings of shortlisted properties. A viewing is linked to the request
 * either through the listing it concerns (a listing-backed shortlist entry
 * of the request) or through a `viewing` appointment booked on the request
 * with the existing booking flow (external properties). Staff confirm,
 * schedule and complete viewings; the customer leaves post-viewing feedback.
 *
 * Lifecycle: requested → confirmed → completed | no_show; cancelled from any
 * open state. Rows carry no version counter: `expectedUpdatedAt` is the token.
 */

type Row = typeof schema.viewings.$inferSelect;
type AppointmentRow = typeof schema.appointments.$inferSelect;

const OPEN = ['requested', 'confirmed'];
const TRANSITIONS: Record<string, string[]> = {
  requested: ['confirmed', 'completed', 'cancelled', 'no_show'],
  confirmed: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: [],
};

async function viewingAppointments(tx: Transaction, serviceRequestId: string) {
  return tx
    .select()
    .from(schema.appointments)
    .where(
      and(
        eq(schema.appointments.serviceRequestId, serviceRequestId),
        eq(schema.appointments.kind, 'viewing'),
      ),
    )
    .orderBy(desc(schema.appointments.startsAt));
}

async function shortlistListingIds(tx: Transaction, serviceRequestId: string): Promise<string[]> {
  const rows = await tx
    .select({ listingId: schema.shortlistItems.listingId })
    .from(schema.shortlistItems)
    .innerJoin(schema.shortlists, eq(schema.shortlists.id, schema.shortlistItems.shortlistId))
    .where(eq(schema.shortlists.serviceRequestId, serviceRequestId));
  return [...new Set(rows.map((r) => r.listingId).filter((v): v is string => !!v))];
}

async function toDtos(
  tx: Transaction,
  rows: Row[],
  appointments: AppointmentRow[],
): Promise<ViewingDto[]> {
  const listingIds = [...new Set(rows.map((r) => r.listingId).filter((v): v is string => !!v))];
  const listings = new Map(
    (await loadPublishedListings({ listingIds, includeHidden: true })).map((l) => [l.id, l]),
  );
  const userIds = [...new Set(rows.map((r) => r.requestedByUserId).filter((v): v is string => !!v))];
  const names = new Map(
    userIds.length === 0
      ? []
      : (
          await tx
            .select({ id: schema.user.id, name: schema.user.name })
            .from(schema.user)
            .where(inArray(schema.user.id, userIds))
        ).map((u) => [u.id, u.name]),
  );
  return rows.map((r) => {
    const appt = r.appointmentId ? appointments.find((a) => a.id === r.appointmentId) : undefined;
    const listing = r.listingId ? listings.get(r.listingId) : undefined;
    return {
      id: r.id,
      listingId: r.listingId,
      title: listing?.title ?? appt?.topic ?? 'Viewing',
      status: r.status,
      scheduledAt: r.scheduledAt?.toISOString() ?? appt?.startsAt.toISOString() ?? null,
      appointmentId: r.appointmentId,
      appointmentStatus: appt?.status ?? null,
      feedback: r.feedback,
      requestedByName: r.requestedByUserId ? (names.get(r.requestedByUserId) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

/** Viewings linked to the request (by shortlisted listing or by booked appointment). */
export async function listViewingsForRequest(
  tx: Transaction,
  ws: WorkspaceAccess,
): Promise<{
  items: ViewingDto[];
  unlinkedAppointments: Array<{ id: string; startsAt: string; status: string }>;
}> {
  const sr = ws.access.sr;
  const appointments = await viewingAppointments(tx, sr.id);
  const listingIds = await shortlistListingIds(tx, sr.id);
  const appointmentIds = appointments.map((a) => a.id);
  const conditions = [
    listingIds.length > 0
      ? and(
          inArray(schema.viewings.listingId, listingIds),
          eq(schema.viewings.organizationId, sr.organizationId),
        )
      : undefined,
    appointmentIds.length > 0 ? inArray(schema.viewings.appointmentId, appointmentIds) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  if (conditions.length === 0) {
    return {
      items: [],
      unlinkedAppointments: appointments.map((a) => ({
        id: a.id,
        startsAt: a.startsAt.toISOString(),
        status: a.status,
      })),
    };
  }
  const rows = await tx
    .select()
    .from(schema.viewings)
    .where(conditions.length === 1 ? conditions[0] : or(...conditions))
    .orderBy(asc(schema.viewings.createdAt));
  const linked = new Set(rows.map((r) => r.appointmentId).filter(Boolean));
  return {
    items: await toDtos(tx, rows, appointments),
    unlinkedAppointments: appointments
      .filter((a) => !linked.has(a.id))
      .map((a) => ({ id: a.id, startsAt: a.startsAt.toISOString(), status: a.status })),
  };
}

async function loadViewing(
  tx: Transaction,
  identity: RequestIdentity,
  id: string,
): Promise<{ row: Row; ws: WorkspaceAccess; serviceRequestId: string }> {
  const [row] = await tx.select().from(schema.viewings).where(eq(schema.viewings.id, id));
  if (!row) throw notFound('viewing');
  // Resolve the request through the appointment or the shortlisted listing.
  let serviceRequestId: string | null = null;
  if (row.appointmentId) {
    const [appt] = await tx
      .select({ serviceRequestId: schema.appointments.serviceRequestId })
      .from(schema.appointments)
      .where(eq(schema.appointments.id, row.appointmentId));
    serviceRequestId = appt?.serviceRequestId ?? null;
  }
  if (!serviceRequestId && row.listingId && row.organizationId) {
    const [link] = await tx
      .select({ serviceRequestId: schema.shortlists.serviceRequestId })
      .from(schema.shortlistItems)
      .innerJoin(schema.shortlists, eq(schema.shortlists.id, schema.shortlistItems.shortlistId))
      .where(
        and(
          eq(schema.shortlistItems.listingId, row.listingId),
          eq(schema.shortlists.organizationId, row.organizationId),
        ),
      )
      .orderBy(desc(schema.shortlists.createdAt))
      .limit(1);
    serviceRequestId = link?.serviceRequestId ?? null;
  }
  if (!serviceRequestId) throw notFound('viewing');
  const ws = await requireWorkspace(tx, identity, serviceRequestId);
  return { row, ws, serviceRequestId };
}

async function dtoOf(tx: Transaction, row: Row, serviceRequestId: string): Promise<ViewingDto> {
  const appointments = await viewingAppointments(tx, serviceRequestId);
  const [dto] = await toDtos(tx, [row], appointments);
  return dto!;
}

/** The customer (or staff for them) asks to view a shortlisted property or links a booked viewing. */
export async function requestViewing(
  identity: RequestIdentity,
  serviceRequestId: string,
  input: ViewingRequest,
  options: ServiceOptions = {},
): Promise<ViewingDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const ws = await requireWorkspace(tx, identity, serviceRequestId);
    requireCustomerOrStaff(identity, ws, 'org.appointments.manage');
    assertRequestOpen(ws);
    const sr = ws.access.sr;
    let values: typeof schema.viewings.$inferInsert;
    let title = 'Viewing';
    let itemId: string | null = null;
    if (input.shortlistItemId) {
      const [item] = await tx
        .select({ item: schema.shortlistItems, shortlist: schema.shortlists })
        .from(schema.shortlistItems)
        .innerJoin(schema.shortlists, eq(schema.shortlists.id, schema.shortlistItems.shortlistId))
        .where(eq(schema.shortlistItems.id, input.shortlistItemId));
      if (!item || item.shortlist.serviceRequestId !== serviceRequestId)
        throw notFound('shortlist entry');
      if (!item.item.listingId) {
        throw new ApiError(
          'validation_failed',
          'this entry is an external property: book a viewing appointment on the request and link it',
          { details: [{ path: 'shortlistItemId', message: 'external entry' }] },
        );
      }
      const open = await tx
        .select({ id: schema.viewings.id })
        .from(schema.viewings)
        .where(
          and(
            eq(schema.viewings.listingId, item.item.listingId),
            eq(schema.viewings.organizationId, sr.organizationId),
            inArray(schema.viewings.status, ['requested', 'confirmed']),
          ),
        );
      if (open.length > 0)
        throw new ApiError('conflict', 'a viewing of this property is already requested');
      title = item.item.title;
      itemId = item.item.id;
      values = {
        organizationId: sr.organizationId,
        listingId: item.item.listingId,
        requestedByUserId: actorId,
        status: 'requested',
      };
    } else {
      const [appt] = await tx
        .select()
        .from(schema.appointments)
        .where(eq(schema.appointments.id, input.appointmentId!));
      if (!appt || appt.serviceRequestId !== serviceRequestId || appt.kind !== 'viewing')
        throw notFound('viewing appointment on this request');
      const linked = await tx
        .select({ id: schema.viewings.id })
        .from(schema.viewings)
        .where(eq(schema.viewings.appointmentId, appt.id));
      if (linked.length > 0) throw new ApiError('conflict', 'this appointment is already linked to a viewing');
      title = appt.topic ?? 'Viewing appointment';
      values = {
        organizationId: sr.organizationId,
        appointmentId: appt.id,
        requestedByUserId: actorId,
        status: appt.status === 'confirmed' ? 'confirmed' : 'requested',
        scheduledAt: appt.startsAt,
      };
    }
    const [row] = await tx.insert(schema.viewings).values(values).returning();
    if (itemId) {
      await tx
        .update(schema.shortlistItems)
        .set({ status: 'viewing_requested' })
        .where(and(eq(schema.shortlistItems.id, itemId), eq(schema.shortlistItems.status, 'candidate')));
    }
    await recordAudit(tx, identity, {
      action: 'viewing.requested',
      entityType: 'viewing',
      entityId: row!.id,
      organizationId: sr.organizationId,
      after: {
        serviceRequestId,
        listingId: row!.listingId,
        appointmentId: row!.appointmentId,
        preferredTimes: input.preferredTimes ?? null,
      },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'viewing.requested',
      aggregateType: 'viewing',
      aggregateId: row!.id,
      organizationId: sr.organizationId,
      actorUserId: actorId,
      payload: {
        viewingId: row!.id,
        serviceRequestId,
        title,
        preferredTimes: input.preferredTimes ?? null,
        recipientUserIds: ws.access.staffAssigneeIds,
      },
      correlationId: options.correlationId ?? null,
    });
    return dtoOf(tx, row!, serviceRequestId);
  });
}

/** Staff confirm, schedule, complete or cancel a viewing. */
export async function updateViewing(
  identity: RequestIdentity,
  id: string,
  input: ViewingUpdate,
  options: ServiceOptions = {},
): Promise<ViewingDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { row, ws, serviceRequestId } = await loadViewing(tx, identity, id);
    requireStaffManage(identity, ws);
    assertRequestOpen(ws);
    assertUpdatedAt(row.updatedAt, input.expectedUpdatedAt);
    const nextStatus = input.status ?? row.status;
    if (nextStatus !== row.status && !TRANSITIONS[row.status]?.includes(nextStatus)) {
      throw new ApiError('invalid_transition', `a ${row.status} viewing cannot become ${nextStatus}`);
    }
    if (!OPEN.includes(row.status) && (input.scheduledAt !== undefined || input.appointmentId !== undefined)) {
      throw new ApiError('invalid_transition', `a ${row.status} viewing can no longer be rescheduled`);
    }
    let appointmentId = row.appointmentId;
    let scheduledAt = input.scheduledAt === undefined ? row.scheduledAt : input.scheduledAt ? new Date(input.scheduledAt) : null;
    if (input.appointmentId !== undefined) {
      if (input.appointmentId === null) appointmentId = null;
      else {
        const [appt] = await tx
          .select()
          .from(schema.appointments)
          .where(eq(schema.appointments.id, input.appointmentId));
        if (!appt || appt.serviceRequestId !== serviceRequestId || appt.kind !== 'viewing')
          throw notFound('viewing appointment on this request');
        appointmentId = appt.id;
        scheduledAt = input.scheduledAt === undefined ? appt.startsAt : scheduledAt;
      }
    }
    if (nextStatus === 'confirmed' && !scheduledAt) {
      throw new ApiError('validation_failed', 'a confirmed viewing needs a scheduled time', {
        details: [{ path: 'scheduledAt', message: 'required to confirm' }],
      });
    }
    const [updated] = await tx
      .update(schema.viewings)
      .set({ status: nextStatus, scheduledAt, appointmentId, updatedAt: new Date() })
      .where(eq(schema.viewings.id, id))
      .returning();
    if (row.listingId && nextStatus === 'completed') {
      await tx
        .update(schema.shortlistItems)
        .set({ status: 'viewed' })
        .where(
          and(
            eq(schema.shortlistItems.listingId, row.listingId),
            inArray(schema.shortlistItems.status, ['candidate', 'viewing_requested']),
            inArray(
              schema.shortlistItems.shortlistId,
              tx
                .select({ id: schema.shortlists.id })
                .from(schema.shortlists)
                .where(eq(schema.shortlists.serviceRequestId, serviceRequestId)),
            ),
          ),
        );
    }
    await recordAudit(tx, identity, {
      action: nextStatus !== row.status ? `viewing.${nextStatus}` : 'viewing.rescheduled',
      entityType: 'viewing',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status, scheduledAt: row.scheduledAt?.toISOString() ?? null },
      after: { status: nextStatus, scheduledAt: scheduledAt?.toISOString() ?? null, appointmentId },
      correlationId: options.correlationId,
    });
    const dto = await dtoOf(tx, updated!, serviceRequestId);
    await appendOutbox(tx, {
      eventType: 'viewing.updated',
      aggregateType: 'viewing',
      aggregateId: id,
      organizationId: row.organizationId,
      actorUserId: actorId,
      payload: {
        viewingId: id,
        serviceRequestId,
        status: nextStatus,
        title: dto.title,
        recipientUserIds: [row.requestedByUserId ?? ws.access.sr.requestedByUserId],
      },
      correlationId: options.correlationId ?? null,
    });
    return dto;
  });
}

/** Post-viewing feedback by the customer (once the viewing took place). */
export async function giveViewingFeedback(
  identity: RequestIdentity,
  id: string,
  input: ViewingFeedback,
  options: ServiceOptions = {},
): Promise<ViewingDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { row, ws, serviceRequestId } = await loadViewing(tx, identity, id);
    requireCustomer(identity, ws, 'org.comment');
    assertUpdatedAt(row.updatedAt, input.expectedUpdatedAt);
    const happened =
      row.status === 'completed' ||
      (row.status === 'confirmed' && row.scheduledAt !== null && row.scheduledAt < new Date());
    if (!happened) {
      throw new ApiError('invalid_transition', 'feedback can be given once the viewing has taken place');
    }
    const [updated] = await tx
      .update(schema.viewings)
      .set({ feedback: input.feedback, updatedAt: new Date() })
      .where(eq(schema.viewings.id, id))
      .returning();
    await recordAudit(tx, identity, {
      action: 'viewing.feedback',
      entityType: 'viewing',
      entityId: id,
      organizationId: row.organizationId,
      after: { feedback: input.feedback },
      correlationId: options.correlationId,
    });
    return dtoOf(tx, updated!, serviceRequestId);
  });
}
