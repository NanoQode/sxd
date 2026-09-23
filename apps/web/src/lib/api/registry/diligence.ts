import { z } from 'zod';
import {
  engagementItemCreateSchema,
  engagementItemDtoSchema,
  engagementItemEvidenceSchema,
  engagementItemListQuerySchema,
  engagementItemResponseCreateSchema,
  engagementItemTransitionSchema,
  engagementItemUpdateSchema,
  engagementWorkspaceDtoSchema,
  listRoutes,
  myEngagementItemsQuerySchema,
  pageOf,
  registerRoute,
  reportDetailDtoSchema,
  reportDtoSchema,
  reportTemplateOutlineDtoSchema,
  serviceRequestReportCreateSchema,
  uuidSchema,
  type HttpMethod,
  type RouteSpec,
} from '@simplexd/contracts';

/**
 * OpenAPI registrations for engagement records (due-diligence checklists,
 * survey references, site findings, queries, red flags, closing checklists),
 * reports drafted under a service request and the released-report export.
 * Route handlers import this module for its side effect; registration is
 * idempotent so hot reloads never trip the duplicate guard.
 */

function ensure(spec: RouteSpec): RouteSpec {
  const existing = listRoutes().find((r) => r.operationId === spec.operationId);
  return existing ?? registerRoute(spec);
}

const idParams = z.object({ id: uuidSchema });

interface Op {
  id: string;
  method: HttpMethod;
  path: string;
  summary: string;
  permission: string;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodTypeAny;
  response?: z.ZodTypeAny;
  responseDescription?: string;
  status?: number;
  auth?: RouteSpec['auth'];
}

function op(o: Op): RouteSpec {
  const status = o.status ?? 200;
  return ensure({
    method: o.method,
    path: o.path,
    summary: o.summary,
    description: `Authorisation: ${o.permission}. Mutations are versioned (expectedVersion), audited and announced through outbox events where someone must act.`,
    tags: ['engagements'],
    operationId: o.id,
    auth: o.auth ?? 'session',
    request: {
      ...(o.params ? { params: o.params } : {}),
      ...(o.query ? { query: o.query } : {}),
      ...(o.body ? { body: o.body } : {}),
    },
    responses: {
      [status]: {
        description: o.responseDescription ?? 'OK',
        ...(o.response ? { body: o.response } : {}),
      },
    },
  });
}

export const engagementRoutes: RouteSpec[] = [
  op({
    id: 'engagements.items.list',
    method: 'get',
    path: '/api/v1/service-requests/{id}/engagement-items',
    summary:
      'Engagement records on a request as the caller may see them (staff: all; customers: customer-visible; partners: assigned and partner-visible)',
    permission:
      'staff service_requests.read_all / org.read / partner.assignments.view with an accepted assignment',
    params: idParams,
    query: engagementItemListQuerySchema,
    response: pageOf(engagementItemDtoSchema),
  }),
  op({
    id: 'engagements.items.create',
    method: 'post',
    path: '/api/v1/service-requests/{id}/engagement-items',
    summary:
      'Create a checklist item, survey reference, site finding, query, red flag, condition, closing task, handover document or lease milestone',
    permission:
      'staff service_requests.triage or projects.manage on the request (site findings also: an attached inspector with site_visits.perform)',
    params: idParams,
    body: engagementItemCreateSchema,
    response: engagementItemDtoSchema,
    status: 201,
    auth: 'staff',
  }),
  op({
    id: 'engagements.items.mine',
    method: 'get',
    path: '/api/v1/engagement-items/mine',
    summary: 'Items assigned to the caller across requests (partner workspace, staff)',
    permission: 'assignee (partners: partner.assignments.view with an accepted assignment)',
    query: myEngagementItemsQuerySchema,
    response: pageOf(engagementItemDtoSchema),
  }),
  op({
    id: 'engagements.items.get',
    method: 'get',
    path: '/api/v1/engagement-items/{id}',
    summary: 'One item with the evidence and responses the caller may see',
    permission: 'as list; items outside the caller’s view answer not found',
    params: idParams,
    response: engagementItemDtoSchema,
  }),
  op({
    id: 'engagements.items.update',
    method: 'patch',
    path: '/api/v1/engagement-items/{id}',
    summary: 'Update fields (managers: all; the assignee: detail, reference and severity)',
    permission: 'staff managing the request, or the assignee',
    params: idParams,
    body: engagementItemUpdateSchema,
    response: engagementItemDtoSchema,
  }),
  op({
    id: 'engagements.items.transition',
    method: 'post',
    path: '/api/v1/engagement-items/{id}/transition',
    summary:
      'Move the status: in_progress, satisfied, failed (reason), waived and cancelled (staff, reason), reopen (reason)',
    permission: 'staff managing the request, or the assignee for in_progress/satisfied/failed',
    params: idParams,
    body: engagementItemTransitionSchema,
    response: engagementItemDtoSchema,
  }),
  op({
    id: 'engagements.items.evidence',
    method: 'post',
    path: '/api/v1/engagement-items/{id}/evidence',
    summary:
      'Attach evidence files: managers, the assignee (own uploads), customers (documents against checklist items that accept them)',
    permission:
      'staff managing the request / assignee with partner.evidence.upload / org.documents.upload for customer-visible document checks and queries',
    params: idParams,
    body: engagementItemEvidenceSchema,
    response: engagementItemDtoSchema,
  }),
  op({
    id: 'engagements.items.respond',
    method: 'post',
    path: '/api/v1/engagement-items/{id}/responses',
    summary: 'Answer a query (customer, org.comment) or reply on an item (staff, assignee)',
    permission:
      'org.comment on a customer-visible open query / staff managing the request / assignee',
    params: idParams,
    body: engagementItemResponseCreateSchema,
    response: engagementItemDtoSchema,
    status: 201,
  }),
  op({
    id: 'engagements.workspace.get',
    method: 'get',
    path: '/api/v1/service-requests/{id}/workspace',
    summary:
      'Engagement workspace: items, summary, reports (customers: released only) and linked appointments with the live meeting link for participants',
    permission: 'staff service_requests.read_all / org.read / assigned partner',
    params: idParams,
    response: engagementWorkspaceDtoSchema,
  }),
  op({
    id: 'engagements.reports.list',
    method: 'get',
    path: '/api/v1/service-requests/{id}/reports',
    summary: 'Reports linked to a request (customers: released ones only)',
    permission: 'staff service_requests.read_all / reports.draft / org.reports.view',
    params: idParams,
    response: z.object({ items: z.array(reportDtoSchema) }),
  }),
  op({
    id: 'engagements.reports.create',
    method: 'post',
    path: '/api/v1/service-requests/{id}/reports',
    summary:
      'Draft a decision memorandum or virtual inspection report under a request, prefilled from the active template of the kind',
    permission: 'staff reports.draft on the request',
    params: idParams,
    body: serviceRequestReportCreateSchema,
    response: reportDetailDtoSchema.extend({ template: reportTemplateOutlineDtoSchema }),
    status: 201,
    auth: 'staff',
  }),
  op({
    id: 'engagements.reportTemplates.outline',
    method: 'get',
    path: '/api/v1/report-templates/outline',
    summary: 'Section outline and author guidance of the active template for a report kind',
    permission: 'staff reports.draft or reports.review',
    query: z.object({
      kind: z.enum(['diligence_memo', 'virtual_inspection']),
      templateId: uuidSchema.optional(),
    }),
    response: reportTemplateOutlineDtoSchema,
    auth: 'staff',
  }),
  op({
    id: 'reports.export',
    method: 'get',
    path: '/api/v1/reports/{id}/export',
    summary:
      'Print-ready HTML of the released report version (title, version, release date, named reviewer, sections, limitations, evidence references by name and checksum). Use the browser’s Print → Save as PDF for a PDF copy.',
    permission:
      'same as reading the released report (staff read / org.reports.view); the export is audited',
    params: idParams,
    query: z.object({ download: z.enum(['1']).optional() }),
    responseDescription:
      'text/html document (Content-Disposition inline, or attachment with ?download=1)',
  }),
];
