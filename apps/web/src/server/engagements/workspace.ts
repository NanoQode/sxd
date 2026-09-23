import 'server-only';
import { asc, eq } from 'drizzle-orm';
import type { EngagementWorkspaceDto, WorkspaceAppointmentDto } from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import { summarizeItems } from '@simplexd/domain/engagements';
import type { RequestIdentity } from '@/lib/auth/session';
import { REQUEST_DRAFT_CHECKS } from '@/server/projects/reports';
import { ctxFor, userIdOf } from '@/server/projects/shared';
import {
  REQUEST_READ_CHECKS,
  allowsRequest,
  isRequestCustomer,
  requireServiceRequest,
} from './access';
import { buildItemDtos, canManageItems, visibleItemsOf } from './items';
import { listReportsForRequest } from './reports';

/**
 * Engagement workspace read model for one service request: the items the
 * caller may see (grouped by the interface), their summary, reports
 * (customers: released only; partners: none) and linked appointments with
 * the live meeting link for participants of a ready conference.
 */

const ACTIVE_APPOINTMENT_STATUSES = ['pending_confirmation', 'confirmed', 'rescheduled'];

export async function getEngagementWorkspace(
  identity: RequestIdentity,
  serviceRequestId: string,
): Promise<EngagementWorkspaceDto> {
  userIdOf(identity);
  const ctx = ctxFor(identity);
  return withActor(getDb(), ctx, async (tx) => {
    const access = await requireServiceRequest(tx, identity, serviceRequestId, REQUEST_READ_CHECKS);
    const staff = identity.actor.staffRoles.length > 0;
    const customer = isRequestCustomer(identity, access);
    const viewer: EngagementWorkspaceDto['viewer'] = staff
      ? 'staff'
      : customer
        ? 'customer'
        : 'partner';
    const [service] = await tx
      .select({ name: schema.services.name, key: schema.services.workflowTemplateKey })
      .from(schema.services)
      .where(eq(schema.services.id, access.sr.serviceId));
    const entries = await visibleItemsOf(tx, identity, access);
    // Checklist order: sort order first, then oldest first, so the list reads like a checklist.
    entries.sort(
      (a, b) =>
        a.row.sortOrder - b.row.sortOrder || a.row.createdAt.getTime() - b.row.createdAt.getTime(),
    );
    const items = await buildItemDtos(tx, identity, ctx, entries);
    const summary = summarizeItems(entries.map((e) => e.row));
    const reportsVisible =
      staff || (customer && allowsRequest(identity, access, [{ org: 'org.reports.view' }]));
    const reports = reportsVisible
      ? await listReportsForRequest(tx, identity, serviceRequestId)
      : [];
    let appointments: WorkspaceAppointmentDto[] = [];
    if (viewer !== 'partner') {
      const rows = await tx
        .select({ a: schema.appointments, staffName: schema.user.name })
        .from(schema.appointments)
        .leftJoin(schema.user, eq(schema.user.id, schema.appointments.staffUserId))
        .where(eq(schema.appointments.serviceRequestId, serviceRequestId))
        .orderBy(asc(schema.appointments.startsAt))
        .limit(50);
      appointments = rows.map(({ a, staffName }) => ({
        id: a.id,
        kind: a.kind,
        status: a.status,
        startsAt: a.startsAt.toISOString(),
        endsAt: a.endsAt.toISOString(),
        meetingProvider: a.meetingProvider,
        conferenceStatus: a.conferenceStatus,
        meetingUrl:
          a.conferenceStatus === 'ready' && ACTIVE_APPOINTMENT_STATUSES.includes(a.status)
            ? a.meetingUrl
            : null,
        staffName,
      }));
    }
    return {
      serviceRequestId: access.sr.id,
      reference: access.sr.reference,
      title: access.sr.title,
      status: access.sr.status,
      serviceName: service?.name ?? 'Service',
      workflowTemplateKey: service?.key ?? 'unknown',
      viewer,
      items,
      summary: {
        total: summary.total,
        open: summary.open,
        resolved: summary.resolved,
        redFlags: summary.redFlags,
        openCustomerQueries: summary.openCustomerQueries,
        openDocumentRequests: summary.openDocumentRequests,
      },
      reports,
      appointments,
      canManageItems: canManageItems(identity, access),
      canDraftReports: staff && allowsRequest(identity, access, REQUEST_DRAFT_CHECKS),
    };
  });
}
