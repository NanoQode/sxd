import 'server-only';
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { StaffAssigneeDto } from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';
import { listStaffAssignees } from '@/server/leads/admin';
import { can, iso, orgNames, requireAnyStaff, staffTx, userNames } from './context';

export interface WorkloadRow {
  userId: string;
  name: string;
  email: string;
  kind: 'staff' | 'partner';
  roles: string[];
  partnerType: string | null;
  verificationStatus: string | null;
  assignments: Record<string, number>;
  activeTotal: number;
  pmRequests: number;
  upcomingVisits: number;
  upcomingAppointments: number;
}

export interface AssignmentRow {
  id: string;
  serviceRequestId: string | null;
  projectId: string | null;
  targetLabel: string;
  organizationName: string;
  assigneeUserId: string;
  assigneeName: string | null;
  role: string;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
}

export interface CalendarEntry {
  id: string;
  kind: 'appointment' | 'site_visit';
  title: string;
  status: string;
  startsAt: string;
  endsAt: string | null;
  staffUserId: string | null;
  staffName: string | null;
  href: string;
}

const ACTIVE = ['proposed', 'accepted', 'active'];

/** Workload per staff member and partner: assignment counts, PM load, upcoming visits and appointments. */
export async function workloadView(
  identity: RequestIdentity,
  filters: { status?: string; assignee?: string; page: number; pageSize: number },
): Promise<{
  workload: WorkloadRow[];
  assignments: AssignmentRow[];
  total: number;
  staff: StaffAssigneeDto[];
  canAssign: boolean;
}> {
  requireAnyStaff(identity, ['service_requests.assign', 'projects.manage', 'service_requests.read_all']);
  const staff = await listStaffAssignees(identity);
  return staffTx(identity, async (tx) => {
    const now = new Date();
    const horizon = new Date(now.getTime() + 7 * 24 * 3_600_000);
    const partners = await tx
      .select({
        userId: schema.partnerProfiles.userId,
        partnerType: schema.partnerProfiles.partnerType,
        verificationStatus: schema.partnerProfiles.verificationStatus,
        name: schema.user.name,
        email: schema.user.email,
      })
      .from(schema.partnerProfiles)
      .innerJoin(schema.user, eq(schema.user.id, schema.partnerProfiles.userId));
    const counts = await tx
      .select({
        assigneeUserId: schema.assignments.assigneeUserId,
        status: schema.assignments.status,
        n: count(),
      })
      .from(schema.assignments)
      .groupBy(schema.assignments.assigneeUserId, schema.assignments.status);
    const pmLoad = await tx
      .select({ userId: schema.serviceRequests.assignedPmUserId, n: count() })
      .from(schema.serviceRequests)
      .where(
        and(
          inArray(schema.serviceRequests.status, [
            'triage',
            'quoted',
            'accepted',
            'awaiting_payment',
            'in_progress',
            'in_review',
          ]),
          sql`${schema.serviceRequests.assignedPmUserId} is not null`,
        ),
      )
      .groupBy(schema.serviceRequests.assignedPmUserId);
    const visits = await tx
      .select({ userId: schema.siteVisits.inspectorUserId, n: count() })
      .from(schema.siteVisits)
      .where(
        and(
          inArray(schema.siteVisits.status, ['scheduled', 'in_progress']),
          gte(schema.siteVisits.scheduledAt, now),
          lt(schema.siteVisits.scheduledAt, horizon),
        ),
      )
      .groupBy(schema.siteVisits.inspectorUserId);
    const appts = await tx
      .select({ userId: schema.appointments.staffUserId, n: count() })
      .from(schema.appointments)
      .where(
        and(
          inArray(schema.appointments.status, ['pending_confirmation', 'confirmed', 'rescheduled']),
          gte(schema.appointments.startsAt, now),
          lt(schema.appointments.startsAt, horizon),
        ),
      )
      .groupBy(schema.appointments.staffUserId);
    const countMap = new Map<string, Record<string, number>>();
    for (const c of counts) {
      const rec = countMap.get(c.assigneeUserId) ?? {};
      rec[c.status] = Number(c.n);
      countMap.set(c.assigneeUserId, rec);
    }
    const pmMap = new Map(pmLoad.map((p) => [p.userId ?? '', Number(p.n)]));
    const visitMap = new Map(visits.map((v) => [v.userId ?? '', Number(v.n)]));
    const apptMap = new Map(appts.map((a) => [a.userId ?? '', Number(a.n)]));
    const row = (
      userId: string,
      name: string,
      email: string,
      kind: 'staff' | 'partner',
      roles: string[],
      partnerType: string | null,
      verificationStatus: string | null,
    ): WorkloadRow => {
      const a = countMap.get(userId) ?? {};
      return {
        userId,
        name,
        email,
        kind,
        roles,
        partnerType,
        verificationStatus,
        assignments: a,
        activeTotal: ACTIVE.reduce((s, k) => s + (a[k] ?? 0), 0),
        pmRequests: pmMap.get(userId) ?? 0,
        upcomingVisits: visitMap.get(userId) ?? 0,
        upcomingAppointments: apptMap.get(userId) ?? 0,
      };
    };
    const workload = [
      ...staff.map((s) => row(s.userId, s.name, s.email, 'staff', s.roles, null, null)),
      ...partners
        .filter((p) => !staff.some((s) => s.userId === p.userId))
        .map((p) => row(p.userId, p.name, p.email, 'partner', [], p.partnerType, p.verificationStatus)),
    ];

    const where = and(
      filters.status ? eq(schema.assignments.status, filters.status as never) : undefined,
      filters.assignee ? eq(schema.assignments.assigneeUserId, filters.assignee) : undefined,
    );
    const [totalRow] = await tx.select({ n: count() }).from(schema.assignments).where(where);
    const rows = await tx
      .select({
        a: schema.assignments,
        srRef: schema.serviceRequests.reference,
        srTitle: schema.serviceRequests.title,
        projectName: schema.projects.name,
      })
      .from(schema.assignments)
      .leftJoin(schema.serviceRequests, eq(schema.serviceRequests.id, schema.assignments.serviceRequestId))
      .leftJoin(schema.projects, eq(schema.projects.id, schema.assignments.projectId))
      .where(where)
      .orderBy(desc(schema.assignments.createdAt))
      .limit(filters.pageSize)
      .offset((filters.page - 1) * filters.pageSize);
    const names = await userNames(
      tx,
      rows.map((r) => r.a.assigneeUserId),
    );
    const orgs = await orgNames(
      tx,
      rows.map((r) => r.a.organizationId),
    );
    return {
      workload,
      staff,
      total: Number(totalRow?.n ?? 0),
      canAssign: can(identity, 'service_requests.assign') || can(identity, 'projects.manage'),
      assignments: rows.map((r) => ({
        id: r.a.id,
        serviceRequestId: r.a.serviceRequestId ?? null,
        projectId: r.a.projectId ?? null,
        targetLabel: r.a.serviceRequestId
          ? `${r.srRef ?? 'Request'} · ${r.srTitle ?? ''}`
          : `Project · ${r.projectName ?? r.a.projectId}`,
        organizationName: orgs.get(r.a.organizationId) ?? r.a.organizationId,
        assigneeUserId: r.a.assigneeUserId,
        assigneeName: names.get(r.a.assigneeUserId)?.name ?? null,
        role: r.a.role,
        status: r.a.status,
        startsAt: iso(r.a.startsAt),
        endsAt: iso(r.a.endsAt),
        createdAt: r.a.createdAt.toISOString(),
      })),
    };
  });
}

/** Appointments and site visits within a window, for calendar views. */
export async function calendarEntries(
  identity: RequestIdentity,
  window: { from: Date; to: Date; staffUserId?: string },
): Promise<CalendarEntry[]> {
  requireAnyStaff(identity, ['appointments.manage_all', 'service_requests.assign', 'projects.manage']);
  return staffTx(identity, async (tx) => {
    const appts = await tx
      .select({
        id: schema.appointments.id,
        kind: schema.appointments.kind,
        status: schema.appointments.status,
        startsAt: schema.appointments.startsAt,
        endsAt: schema.appointments.endsAt,
        staffUserId: schema.appointments.staffUserId,
        topic: schema.appointments.topic,
        guestName: schema.appointments.guestName,
      })
      .from(schema.appointments)
      .where(
        and(
          gte(schema.appointments.startsAt, window.from),
          lt(schema.appointments.startsAt, window.to),
          window.staffUserId ? eq(schema.appointments.staffUserId, window.staffUserId) : undefined,
          or(isNull(schema.appointments.status), sql`${schema.appointments.status} <> 'cancelled'`),
        ),
      )
      .orderBy(asc(schema.appointments.startsAt));
    const visits = await tx
      .select({
        id: schema.siteVisits.id,
        status: schema.siteVisits.status,
        scheduledAt: schema.siteVisits.scheduledAt,
        inspectorUserId: schema.siteVisits.inspectorUserId,
        projectId: schema.siteVisits.projectId,
        projectName: schema.projects.name,
      })
      .from(schema.siteVisits)
      .leftJoin(schema.projects, eq(schema.projects.id, schema.siteVisits.projectId))
      .where(
        and(
          gte(schema.siteVisits.scheduledAt, window.from),
          lt(schema.siteVisits.scheduledAt, window.to),
          window.staffUserId ? eq(schema.siteVisits.inspectorUserId, window.staffUserId) : undefined,
          sql`${schema.siteVisits.status} <> 'cancelled'`,
        ),
      )
      .orderBy(asc(schema.siteVisits.scheduledAt));
    const names = await userNames(tx, [
      ...appts.map((a) => a.staffUserId),
      ...visits.map((v) => v.inspectorUserId),
    ]);
    const entries: CalendarEntry[] = [
      ...appts.map((a) => ({
        id: a.id,
        kind: 'appointment' as const,
        title: `${a.kind.replace(/_/g, ' ')}${a.topic ? ` · ${a.topic}` : ''}${a.guestName ? ` · ${a.guestName}` : ''}`,
        status: a.status,
        startsAt: a.startsAt.toISOString(),
        endsAt: a.endsAt.toISOString(),
        staffUserId: a.staffUserId,
        staffName: a.staffUserId ? (names.get(a.staffUserId)?.name ?? null) : null,
        href: `/admin/appointments?date=${a.startsAt.toISOString().slice(0, 10)}&view=day#appt-${a.id}`,
      })),
      ...visits
        .filter((v) => v.scheduledAt)
        .map((v) => ({
          id: v.id,
          kind: 'site_visit' as const,
          title: `Site visit · ${v.projectName ?? 'project'}`,
          status: v.status,
          startsAt: v.scheduledAt!.toISOString(),
          endsAt: null,
          staffUserId: v.inspectorUserId,
          staffName: v.inspectorUserId ? (names.get(v.inspectorUserId)?.name ?? null) : null,
          href: v.projectId ? `/admin/projects/${v.projectId}?tab=visits` : '/admin/projects',
        })),
    ];
    return entries.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  });
}
