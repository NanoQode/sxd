import { and, desc, eq, gte, inArray, lte, or, type SQL } from 'drizzle-orm';
import type { AppointmentDto, AppointmentListQuery, Page } from '@simplexd/contracts';
import { getDb, schema, systemContext, withActor, type Transaction } from '@simplexd/db';
import { orgPermissions } from '@simplexd/domain/authz';
import { decodeCursor, encodeCursor, keysetAfter } from '@/server/portal/pagination';
import { loadAppointment, loadAppointmentByManageToken, type Viewer } from './access';
import { toAppointmentDto, type EventSyncRow } from './dto';
import { loadBookingSettings } from './settings';

/**
 * Read models. Staff with `appointments.manage_all` see every appointment;
 * other staff, partners and inspectors see the ones they organise; customers
 * see their own bookings plus their organisation's when their role carries
 * `org.appointments.manage`. Guests read through the manage token.
 */

function providerFor(sync: EventSyncRow | null): 'google' | 'dev' | null {
  if (!sync) return null;
  if (sync.calendarConnectionId) return 'google';
  return sync.providerEventId ? 'dev' : null;
}

async function syncRowsFor(tx: Transaction, ids: string[]): Promise<Map<string, EventSyncRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(schema.eventSyncs)
    .where(inArray(schema.eventSyncs.appointmentId, ids));
  return new Map(rows.map((r) => [r.appointmentId, r]));
}

async function staffNames(tx: Transaction, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: schema.user.id, name: schema.user.name })
    .from(schema.user)
    .where(inArray(schema.user.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function scopeCondition(viewer: Viewer, query: AppointmentListQuery): SQL | undefined {
  const t = schema.appointments;
  switch (viewer.kind) {
    case 'staff': {
      if (!viewer.manageAll || query.scope === 'mine') return eq(t.staffUserId, viewer.userId);
      return query.staffUserId ? eq(t.staffUserId, query.staffUserId) : undefined;
    }
    case 'customer': {
      const orgIds = viewer.identity.actor.memberships
        .filter((m) => orgPermissions(viewer.identity.actor, m.organizationId).has('org.appointments.manage'))
        .map((m) => m.organizationId);
      return or(
        eq(t.customerUserId, viewer.userId),
        eq(t.staffUserId, viewer.userId),
        orgIds.length > 0 ? inArray(t.organizationId, orgIds) : undefined,
      );
    }
    case 'guest':
      return eq(t.manageToken, viewer.manageToken);
    default:
      return undefined;
  }
}

export async function listAppointments(
  viewer: Viewer,
  query: AppointmentListQuery,
): Promise<Page<AppointmentDto>> {
  const t = schema.appointments;
  const cursor = decodeCursor(query.cursor);
  return withActor(getDb(), systemContext('appointments-list'), async (tx) => {
    const rows = await tx
      .select()
      .from(t)
      .where(
        and(
          scopeCondition(viewer, query),
          query.status ? eq(t.status, query.status) : undefined,
          query.kind ? eq(t.kind, query.kind) : undefined,
          query.from ? gte(t.startsAt, new Date(query.from)) : undefined,
          query.to ? lte(t.startsAt, new Date(query.to)) : undefined,
          cursor ? keysetAfter(t.startsAt, t.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(t.startsAt), desc(t.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const settings = await loadBookingSettings(tx);
    const syncs = viewer.kind === 'staff' ? await syncRowsFor(tx, page.map((r) => r.id)) : new Map();
    const names = await staffNames(tx, [...new Set(page.map((r) => r.staffUserId))]);
    const items = page.map((row) => {
      const sync = (syncs.get(row.id) as EventSyncRow | undefined) ?? null;
      return toAppointmentDto(row, {
        viewer,
        staffName: names.get(row.staffUserId) ?? 'SimplexD team',
        settings,
        sync,
        provider: providerFor(sync),
      });
    });
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return { items, nextCursor: last ? encodeCursor(last.startsAt, last.id) : null };
  });
}

export async function getAppointment(viewer: Viewer, id: string): Promise<AppointmentDto> {
  return withActor(getDb(), systemContext('appointments-get'), async (tx) => {
    const row = await loadAppointment(tx, viewer, id);
    const settings = await loadBookingSettings(tx);
    const syncs = await syncRowsFor(tx, [row.id]);
    const sync = syncs.get(row.id) ?? null;
    const names = await staffNames(tx, [row.staffUserId]);
    return toAppointmentDto(row, {
      viewer,
      staffName: names.get(row.staffUserId) ?? 'SimplexD team',
      settings,
      sync,
      provider: providerFor(sync),
      includeManagePath: viewer.kind === 'guest' || row.customerUserId === (viewer.kind === 'guest' ? null : viewer.userId),
    });
  });
}

export async function getAppointmentByManageToken(manageToken: string): Promise<AppointmentDto> {
  return withActor(getDb(), systemContext('appointments-manage'), async (tx) => {
    const row = await loadAppointmentByManageToken(tx, manageToken);
    const settings = await loadBookingSettings(tx);
    const syncs = await syncRowsFor(tx, [row.id]);
    const sync = syncs.get(row.id) ?? null;
    const names = await staffNames(tx, [row.staffUserId]);
    return toAppointmentDto(row, {
      viewer: { kind: 'guest', manageToken },
      staffName: names.get(row.staffUserId) ?? 'SimplexD team',
      settings,
      sync,
      provider: providerFor(sync),
      includeManagePath: true,
    });
  });
}
