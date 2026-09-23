import 'server-only';
import { and, asc, count, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type {
  AssignmentDto,
  InvoiceDto,
  QuoteDto,
  ServiceRequestDetail,
  StaffAssigneeDto,
} from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import { availableTransitions, engagementMachine } from '@simplexd/domain/workflow';
import { listInvoices, listQuotesForRequest } from '@simplexd/finance';
import type { RequestIdentity } from '@/lib/auth/session';
import { listAssignments } from '@/server/assignments/service';
import { listStaffAssignees } from '@/server/leads/admin';
import { getServiceRequestDetail } from '@/server/requests/queries';
import { summarizeSla, type SlaSummary } from '../sla';
import { can, financeFor, iso, orgNames, requireAnyStaff, staffTx } from './context';

export interface QueueFilters {
  status?: string;
  priority?: number;
  /** A staff user id, or `unassigned`. */
  assignee?: string;
  overdueOnly?: boolean;
  organizationId?: string;
  q?: string;
  page: number;
  pageSize: number;
}

export interface QueueRow {
  id: string;
  reference: string;
  title: string;
  status: string;
  priority: number;
  slaDueAt: string | null;
  sla: SlaSummary;
  serviceName: string;
  serviceSlug: string;
  organizationId: string;
  organizationName: string;
  assignedPm: { id: string; name: string } | null;
  marketName: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const QUEUE_ORDER = sql`case when ${schema.serviceRequests.status} in ('inquiry','triage','quoted','accepted','awaiting_payment','in_progress','in_review') then 0 else 1 end`;

/** Staff-wide SLA queue (needs `service_requests.read_all`). */
export async function listRequestQueue(
  identity: RequestIdentity,
  filters: QueueFilters,
): Promise<{ items: QueueRow[]; total: number; counts: Record<string, number> }> {
  requireAnyStaff(identity, ['service_requests.read_all']);
  return staffTx(identity, async (tx) => {
    const where = and(
      filters.status ? eq(schema.serviceRequests.status, filters.status as never) : undefined,
      filters.priority ? eq(schema.serviceRequests.priority, filters.priority) : undefined,
      filters.assignee === 'unassigned'
        ? isNull(schema.serviceRequests.assignedPmUserId)
        : filters.assignee
          ? eq(schema.serviceRequests.assignedPmUserId, filters.assignee)
          : undefined,
      filters.overdueOnly
        ? and(
            lt(schema.serviceRequests.slaDueAt, sql`now()`),
            inArray(schema.serviceRequests.status, [
              'inquiry',
              'triage',
              'quoted',
              'accepted',
              'awaiting_payment',
              'in_progress',
              'in_review',
            ]),
          )
        : undefined,
      filters.organizationId
        ? eq(schema.serviceRequests.organizationId, filters.organizationId)
        : undefined,
      filters.q
        ? or(
            ilike(schema.serviceRequests.reference, `%${filters.q.replace(/[%_]/g, '')}%`),
            ilike(schema.serviceRequests.title, `%${filters.q.replace(/[%_]/g, '')}%`),
          )
        : undefined,
    );
    const [totalRow] = await tx
      .select({ n: count() })
      .from(schema.serviceRequests)
      .where(where);
    const rows = await tx
      .select({
        sr: schema.serviceRequests,
        service: { slug: schema.services.slug, name: schema.services.name },
        market: { name: schema.markets.name },
        pm: { id: schema.user.id, name: schema.user.name },
      })
      .from(schema.serviceRequests)
      .innerJoin(schema.services, eq(schema.services.id, schema.serviceRequests.serviceId))
      .leftJoin(schema.markets, eq(schema.markets.id, schema.serviceRequests.marketId))
      .leftJoin(schema.user, eq(schema.user.id, schema.serviceRequests.assignedPmUserId))
      .where(where)
      .orderBy(
        QUEUE_ORDER,
        sql`${schema.serviceRequests.slaDueAt} asc nulls last`,
        asc(schema.serviceRequests.priority),
        desc(schema.serviceRequests.createdAt),
      )
      .limit(filters.pageSize)
      .offset((filters.page - 1) * filters.pageSize);
    const countRows = await tx
      .select({ status: schema.serviceRequests.status, n: count() })
      .from(schema.serviceRequests)
      .groupBy(schema.serviceRequests.status);
    const names = await orgNames(
      tx,
      rows.map((r) => r.sr.organizationId),
    );
    const now = new Date();
    const counts: Record<string, number> = {};
    for (const c of countRows) counts[c.status] = Number(c.n);
    return {
      total: Number(totalRow?.n ?? 0),
      counts,
      items: rows.map((r) => ({
        id: r.sr.id,
        reference: r.sr.reference,
        title: r.sr.title,
        status: r.sr.status,
        priority: r.sr.priority,
        slaDueAt: iso(r.sr.slaDueAt),
        sla: summarizeSla(iso(r.sr.slaDueAt), r.sr.status, now),
        serviceName: r.service.name,
        serviceSlug: r.service.slug,
        organizationId: r.sr.organizationId,
        organizationName: names.get(r.sr.organizationId) ?? r.sr.organizationId,
        assignedPm: r.pm?.id && r.pm.name ? { id: r.pm.id, name: r.pm.name } : null,
        marketName: r.market?.name ?? null,
        version: r.sr.version,
        createdAt: r.sr.createdAt.toISOString(),
        updatedAt: r.sr.updatedAt.toISOString(),
      })),
    };
  });
}

export interface QuoteTemplateOption {
  id: string;
  name: string;
  lineCount: number;
}

export interface LinkedAppointment {
  id: string;
  kind: string;
  status: string;
  startsAt: string;
  staffName: string | null;
}

export interface LinkedSiteVisit {
  id: string;
  projectId: string | null;
  status: string;
  scheduledAt: string | null;
  inspectorName: string | null;
}

export interface StaffRequestView {
  request: ServiceRequestDetail;
  organization: { id: string; name: string };
  requestedBy: { id: string; name: string; email: string } | null;
  slaDueAt: string | null;
  sla: SlaSummary;
  lead: { id: string; contactName: string; status: string } | null;
  project: { id: string; name: string; status: string } | null;
  propertyId: string | null;
  quotes: QuoteDto[];
  invoices: InvoiceDto[];
  assignments: AssignmentDto[];
  appointments: LinkedAppointment[];
  siteVisits: LinkedSiteVisit[];
  templates: QuoteTemplateOption[];
  taxTreatments: Array<{ key: string; name: string; rateBps: number }>;
  staff: StaffAssigneeDto[];
  staffTransitions: Array<{ to: string; reasonRequired: boolean; effect: string | null }>;
  permissions: {
    triage: boolean;
    assign: boolean;
    override: boolean;
    quote: boolean;
    finance: boolean;
    projects: boolean;
  };
}

/** Everything the staff request page needs, permission-filtered. */
export async function getStaffRequestView(
  identity: RequestIdentity,
  id: string,
): Promise<StaffRequestView> {
  requireAnyStaff(identity, ['service_requests.read_all']);
  const request = await getServiceRequestDetail(identity, id);
  const { rt, fa } = financeFor(identity);
  const [quotes, invoices, assignments, staff] = await Promise.all([
    listQuotesForRequest(rt, fa, id),
    can(identity, 'finance.read')
      ? listInvoices(rt, fa, { serviceRequestId: id, limit: 50 }).then((p) => p.items)
      : Promise.resolve([] as InvoiceDto[]),
    listAssignments(identity, { serviceRequestId: id, limit: 50 }).then((p) => p.items),
    listStaffAssignees(identity),
  ]);
  const extra = await staffTx(identity, async (tx) => {
    const [sr] = await tx
      .select({
        organizationId: schema.serviceRequests.organizationId,
        requestedByUserId: schema.serviceRequests.requestedByUserId,
        slaDueAt: schema.serviceRequests.slaDueAt,
        leadId: schema.serviceRequests.leadId,
        projectId: schema.serviceRequests.projectId,
        propertyId: schema.serviceRequests.propertyId,
        serviceId: schema.serviceRequests.serviceId,
      })
      .from(schema.serviceRequests)
      .where(eq(schema.serviceRequests.id, id));
    if (!sr) throw new Error('request not found');
    const [org] = await tx
      .select({ id: schema.organization.id, name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, sr.organizationId));
    const requester = sr.requestedByUserId
      ? (
          await tx
            .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
            .from(schema.user)
            .where(eq(schema.user.id, sr.requestedByUserId))
        )[0]
      : null;
    const lead = sr.leadId
      ? (
          await tx
            .select({
              id: schema.leads.id,
              contactName: schema.leads.contactName,
              status: schema.leads.status,
            })
            .from(schema.leads)
            .where(eq(schema.leads.id, sr.leadId))
        )[0]
      : null;
    const project = sr.projectId
      ? (
          await tx
            .select({
              id: schema.projects.id,
              name: schema.projects.name,
              status: schema.projects.status,
            })
            .from(schema.projects)
            .where(eq(schema.projects.id, sr.projectId))
        )[0]
      : null;
    const appointments = await tx
      .select({
        id: schema.appointments.id,
        kind: schema.appointments.kind,
        status: schema.appointments.status,
        startsAt: schema.appointments.startsAt,
        staffName: schema.user.name,
      })
      .from(schema.appointments)
      .leftJoin(schema.user, eq(schema.user.id, schema.appointments.staffUserId))
      .where(eq(schema.appointments.serviceRequestId, id))
      .orderBy(desc(schema.appointments.startsAt))
      .limit(20);
    const visits = await tx
      .select({
        id: schema.siteVisits.id,
        projectId: schema.siteVisits.projectId,
        status: schema.siteVisits.status,
        scheduledAt: schema.siteVisits.scheduledAt,
        inspectorName: schema.user.name,
      })
      .from(schema.siteVisits)
      .leftJoin(schema.user, eq(schema.user.id, schema.siteVisits.inspectorUserId))
      .where(eq(schema.siteVisits.serviceRequestId, id))
      .orderBy(desc(schema.siteVisits.scheduledAt))
      .limit(20);
    const templates = await tx
      .select({
        id: schema.quoteTemplates.id,
        name: schema.quoteTemplates.name,
        lines: schema.quoteTemplates.lines,
      })
      .from(schema.quoteTemplates)
      .where(
        and(
          eq(schema.quoteTemplates.active, true),
          or(eq(schema.quoteTemplates.serviceId, sr.serviceId), isNull(schema.quoteTemplates.serviceId)),
        ),
      )
      .orderBy(asc(schema.quoteTemplates.name));
    const taxTreatments = await tx
      .select({
        key: schema.taxTreatments.key,
        name: schema.taxTreatments.name,
        rateBps: schema.taxTreatments.rateBps,
      })
      .from(schema.taxTreatments)
      .where(eq(schema.taxTreatments.active, true))
      .orderBy(asc(schema.taxTreatments.name));
    return {
      organization: org ?? { id: sr.organizationId, name: sr.organizationId },
      requestedBy: requester ?? null,
      slaDueAt: iso(sr.slaDueAt),
      lead: lead ?? null,
      project: project ?? null,
      propertyId: sr.propertyId,
      appointments: appointments.map((a) => ({
        id: a.id,
        kind: a.kind,
        status: a.status,
        startsAt: a.startsAt.toISOString(),
        staffName: a.staffName ?? null,
      })),
      siteVisits: visits.map((v) => ({
        id: v.id,
        projectId: v.projectId,
        status: v.status,
        scheduledAt: iso(v.scheduledAt),
        inspectorName: v.inspectorName ?? null,
      })),
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        lineCount: Array.isArray(t.lines) ? (t.lines as unknown[]).length : 0,
      })),
      taxTreatments,
    };
  });
  const staffTransitions = availableTransitions(engagementMachine, request.status, 'staff')
    .filter((rule) => rule.to !== 'triage' && rule.to !== 'quoted' && rule.to !== 'awaiting_payment')
    .map((rule) => ({
      to: rule.to,
      reasonRequired: Boolean(rule.reasonRequired),
      effect: rule.effect ?? null,
    }));
  return {
    request,
    ...extra,
    sla: summarizeSla(extra.slaDueAt, request.status),
    quotes,
    invoices,
    assignments,
    staff,
    staffTransitions,
    permissions: {
      triage: can(identity, 'service_requests.triage'),
      assign: can(identity, 'service_requests.assign'),
      override: can(identity, 'service_requests.override'),
      quote: can(identity, 'quotes.issue'),
      finance: can(identity, 'finance.read'),
      projects: can(identity, 'projects.manage'),
    },
  };
}

/** Requests of one organisation (customer page). */
export async function listOrganizationRequests(identity: RequestIdentity, organizationId: string) {
  const res = await listRequestQueue(identity, { organizationId, page: 1, pageSize: 50 });
  return res.items;
}
