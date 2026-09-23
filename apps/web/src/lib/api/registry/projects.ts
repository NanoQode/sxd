import { z } from 'zod';
import {
  approvalDtoSchema,
  approvalsQuerySchema,
  boqItemsReplaceSchema,
  budgetDecisionSchema,
  budgetVarianceDtoSchema,
  budgetVersionCreateSchema,
  budgetVersionDtoSchema,
  changeOrderCreateSchema,
  changeOrderDecisionSchema,
  changeOrderDtoSchema,
  changeOrderListQuerySchema,
  changeOrderSubmitSchema,
  changeOrderUpdateSchema,
  changeOrderWithdrawSchema,
  commitmentCreateSchema,
  commitmentDtoSchema,
  commitmentListQuerySchema,
  defectCreateSchema,
  defectDtoSchema,
  defectListQuerySchema,
  defectTransitionSchema,
  defectUpdateSchema,
  designCommentCreateSchema,
  designCommentDtoSchema,
  designOptionCreateSchema,
  designOptionDtoSchema,
  designOptionNewVersionSchema,
  designOptionUpdateSchema,
  designSignOffSchema,
  evidenceDtoSchema,
  evidenceLinkSchema,
  evidenceListQuerySchema,
  evidenceMutationResponseSchema,
  evidencePublicationUpdateSchema,
  listRoutes,
  milestoneAcceptanceSchema,
  milestoneCreateSchema,
  milestoneDtoSchema,
  milestoneFinanceAuthorizationSchema,
  milestoneProgressSchema,
  milestoneUpdateSchema,
  pageOf,
  pendingApprovalsResponseSchema,
  permitCreateSchema,
  permitDtoSchema,
  permitEventCreateSchema,
  permitUpdateSchema,
  projectCreateSchema,
  projectDtoSchema,
  projectListQuerySchema,
  projectOverviewDtoSchema,
  projectTransitionSchema,
  projectUpdateSchema,
  registerRoute,
  reportCreateSchema,
  reportDetailDtoSchema,
  reportDtoSchema,
  reportListQuerySchema,
  reportReleaseSchema,
  reportReviewSchema,
  reportRevisionCreateSchema,
  reportSubmitSchema,
  scheduleDtoSchema,
  scheduleReplaceSchema,
  scheduleTaskActualsSchema,
  siteVisitCancelSchema,
  siteVisitDtoSchema,
  siteVisitListQuerySchema,
  siteVisitMutationResponseSchema,
  siteVisitReviewSchema,
  siteVisitScheduleSchema,
  siteVisitStartSchema,
  siteVisitSubmitSchema,
  siteVisitSyncResponseSchema,
  siteVisitSyncSchema,
  unresolvedIssuesDtoSchema,
  uuidSchema,
  type HttpMethod,
  type RouteSpec,
} from '@simplexd/contracts';

/**
 * OpenAPI registration for the project delivery engine. Idempotent so hot
 * reloads never trip the duplicate operationId guard. Every operation needs
 * a session; the permission that authorises it is stated in the description.
 */

function ensure(spec: RouteSpec): RouteSpec {
  const existing = listRoutes().find((r) => r.operationId === spec.operationId);
  return existing ?? registerRoute(spec);
}

const idParams = z.object({ id: uuidSchema });
const items = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item) });

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
  status?: number;
  auth?: RouteSpec['auth'];
}

function op(o: Op): RouteSpec {
  const status = o.status ?? 200;
  return ensure({
    method: o.method,
    path: o.path,
    summary: o.summary,
    description: `Authorisation: ${o.permission}. Every mutation records an audit event and, where relevant, an outbox event in the same transaction.`,
    tags: ['projects'],
    operationId: o.id,
    auth: o.auth ?? 'session',
    request: {
      ...(o.params ? { params: o.params } : {}),
      ...(o.query ? { query: o.query } : {}),
      ...(o.body ? { body: o.body } : {}),
    },
    responses: {
      [status]: { description: 'OK', ...(o.response ? { body: o.response } : {}) },
      400: { description: 'Validation failed' },
      401: { description: 'Sign in required' },
      403: { description: 'Forbidden (default deny: role, assignment, organisation or own-work rule)' },
      404: { description: 'Not found or not visible to this organisation' },
      409: { description: 'Conflict, version conflict or invalid transition' },
    },
  });
}

export const projectRoutes: RouteSpec[] = [
  // Projects
  op({ id: 'projects.list', method: 'get', path: '/api/v1/projects', summary: 'List projects the caller may see', permission: 'staff projects.read_all (assigned only for PM/inspector), org.read, partner assignments', query: projectListQuerySchema, response: pageOf(projectDtoSchema) }),
  op({ id: 'projects.create', method: 'post', path: '/api/v1/projects', summary: 'Create a project for a customer organisation', permission: 'staff projects.manage', body: projectCreateSchema, response: projectDtoSchema, status: 201, auth: 'staff' }),
  op({ id: 'projects.get', method: 'get', path: '/api/v1/projects/{id}', summary: 'Project detail', permission: 'project read', params: idParams, response: projectDtoSchema }),
  op({ id: 'projects.update', method: 'patch', path: '/api/v1/projects/{id}', summary: 'Update project fields (optimistic concurrency)', permission: 'staff projects.manage on an assigned project', params: idParams, body: projectUpdateSchema, response: projectDtoSchema, auth: 'staff' }),
  op({ id: 'projects.transition', method: 'post', path: '/api/v1/projects/{id}/transitions', summary: 'Move the project through its lifecycle (reason required for on_hold/cancelled)', permission: 'staff projects.manage', params: idParams, body: projectTransitionSchema, response: projectDtoSchema, auth: 'staff' }),
  op({ id: 'projects.overview', method: 'get', path: '/api/v1/projects/{id}/overview', summary: 'Overview read model: budget, variance, schedule, milestones, defects, latest report, team', permission: 'project read', params: idParams, response: projectOverviewDtoSchema }),
  // Budgets
  op({ id: 'projects.budgets.list', method: 'get', path: '/api/v1/projects/{id}/budgets', summary: 'Budget versions with BOQ items and approvals', permission: 'project read', params: idParams, response: items(budgetVersionDtoSchema) }),
  op({ id: 'projects.budgets.create', method: 'post', path: '/api/v1/projects/{id}/budgets', summary: 'Create a draft budget version (area_rate, boq, quote or manual); totals computed server-side', permission: 'staff projects.manage', params: idParams, body: budgetVersionCreateSchema, response: budgetVersionDtoSchema, status: 201, auth: 'staff' }),
  op({ id: 'budgets.get', method: 'get', path: '/api/v1/budgets/{id}', summary: 'Budget version detail', permission: 'project read', params: idParams, response: budgetVersionDtoSchema }),
  op({ id: 'budgets.items.replace', method: 'put', path: '/api/v1/budgets/{id}/items', summary: 'Replace the BOQ items of an undecided draft version', permission: 'staff projects.manage', params: idParams, body: boqItemsReplaceSchema, response: budgetVersionDtoSchema, auth: 'staff' }),
  op({ id: 'budgets.decide', method: 'post', path: '/api/v1/budgets/{id}/decisions', summary: 'Customer or staff approval decision; approved only when the policy is satisfied', permission: 'org.change_orders.approve or staff projects.manage', params: idParams, body: budgetDecisionSchema, response: budgetVersionDtoSchema }),
  op({ id: 'projects.commitments.list', method: 'get', path: '/api/v1/projects/{id}/commitments', summary: 'Commitments and actuals', permission: 'project read', params: idParams, query: commitmentListQuerySchema, response: pageOf(commitmentDtoSchema) }),
  op({ id: 'projects.commitments.create', method: 'post', path: '/api/v1/projects/{id}/commitments', summary: 'Append a commitment or actual', permission: 'staff projects.manage', params: idParams, body: commitmentCreateSchema, response: commitmentDtoSchema, status: 201, auth: 'staff' }),
  op({ id: 'projects.budgetVariance', method: 'get', path: '/api/v1/projects/{id}/budget-variance', summary: 'Approved vs committed vs actual vs forecast', permission: 'project read', params: idParams, response: budgetVarianceDtoSchema }),
  // Schedule
  op({ id: 'projects.schedule.get', method: 'get', path: '/api/v1/projects/{id}/schedule', summary: 'Current schedule with computed dates, float and critical path', permission: 'project read', params: idParams, response: scheduleDtoSchema }),
  op({ id: 'projects.schedule.replace', method: 'put', path: '/api/v1/projects/{id}/schedule', summary: 'Replace tasks and dependencies as a new schedule version and store a baseline; cycles are rejected', permission: 'staff projects.manage', params: idParams, body: scheduleReplaceSchema, response: scheduleDtoSchema, auth: 'staff' }),
  op({ id: 'projects.schedule.taskActuals', method: 'patch', path: '/api/v1/projects/{id}/schedule/tasks/{key}', summary: 'Record actual start/finish and percent complete for a task', permission: 'staff projects.manage or milestones.record_progress', params: z.object({ id: uuidSchema, key: z.string() }), body: scheduleTaskActualsSchema, response: scheduleDtoSchema, auth: 'staff' }),
  // Milestones
  op({ id: 'projects.milestones.list', method: 'get', path: '/api/v1/projects/{id}/milestones', summary: 'Milestones', permission: 'project read', params: idParams, response: items(milestoneDtoSchema) }),
  op({ id: 'projects.milestones.create', method: 'post', path: '/api/v1/projects/{id}/milestones', summary: 'Create a milestone', permission: 'staff projects.manage', params: idParams, body: milestoneCreateSchema, response: milestoneDtoSchema, status: 201, auth: 'staff' }),
  op({ id: 'milestones.get', method: 'get', path: '/api/v1/milestones/{id}', summary: 'Milestone detail', permission: 'project read', params: idParams, response: milestoneDtoSchema }),
  op({ id: 'milestones.update', method: 'patch', path: '/api/v1/milestones/{id}', summary: 'Update milestone plan fields', permission: 'staff projects.manage', params: idParams, body: milestoneUpdateSchema, response: milestoneDtoSchema, auth: 'staff' }),
  op({ id: 'milestones.progress', method: 'post', path: '/api/v1/milestones/{id}/progress', summary: "Inspector's progress estimate (never implies acceptance)", permission: 'staff milestones.record_progress', params: idParams, body: milestoneProgressSchema, response: milestoneDtoSchema, auth: 'staff' }),
  op({ id: 'milestones.submit', method: 'post', path: '/api/v1/milestones/{id}/submit', summary: 'Present the milestone for customer acceptance', permission: 'staff projects.manage', params: idParams, response: milestoneDtoSchema, auth: 'staff' }),
  op({ id: 'milestones.rework', method: 'post', path: '/api/v1/milestones/{id}/rework', summary: 'Restart work after a customer rejection', permission: 'staff projects.manage', params: idParams, response: milestoneDtoSchema, auth: 'staff' }),
  op({ id: 'milestones.acceptance', method: 'post', path: '/api/v1/milestones/{id}/acceptance', summary: 'Customer acceptance or rejection with reason', permission: 'org.milestones.accept', params: idParams, body: milestoneAcceptanceSchema, response: milestoneDtoSchema }),
  op({ id: 'milestones.financeAuthorization', method: 'post', path: '/api/v1/milestones/{id}/finance-authorization', summary: 'Finance payment authorisation (MFA, accepted milestones only)', permission: 'staff milestones.finance_authorize', params: idParams, body: milestoneFinanceAuthorizationSchema, response: milestoneDtoSchema, auth: 'staff' }),
  // Site visits
  op({ id: 'projects.siteVisits.list', method: 'get', path: '/api/v1/projects/{id}/site-visits', summary: 'Site visits', permission: 'project read', params: idParams, query: siteVisitListQuerySchema, response: pageOf(siteVisitDtoSchema) }),
  op({ id: 'projects.siteVisits.schedule', method: 'post', path: '/api/v1/projects/{id}/site-visits', summary: 'Schedule a visit for a named inspector (offline id replays)', permission: 'staff projects.manage', params: idParams, body: siteVisitScheduleSchema, response: siteVisitMutationResponseSchema, status: 201, auth: 'staff' }),
  op({ id: 'siteVisits.sync', method: 'post', path: '/api/v1/site-visits/sync', summary: 'Offline resume: submit a batch of visits by offline id with per-item outcomes', permission: 'the assigned inspector (site_visits.perform or partner assignment)', body: siteVisitSyncSchema, response: siteVisitSyncResponseSchema }),
  op({ id: 'siteVisits.get', method: 'get', path: '/api/v1/site-visits/{id}', summary: 'Site visit detail', permission: 'project read or the assigned inspector', params: idParams, response: siteVisitDtoSchema }),
  op({ id: 'siteVisits.start', method: 'post', path: '/api/v1/site-visits/{id}/start', summary: 'Inspector starts the visit', permission: 'assigned inspector', params: idParams, body: siteVisitStartSchema, response: siteVisitMutationResponseSchema }),
  op({ id: 'siteVisits.submit', method: 'post', path: '/api/v1/site-visits/{id}/submit', summary: 'Inspector submits findings, checklist and evidence (offline id replays)', permission: 'assigned inspector', params: idParams, body: siteVisitSubmitSchema, response: siteVisitMutationResponseSchema, status: 201 }),
  op({ id: 'siteVisits.review', method: 'post', path: '/api/v1/site-visits/{id}/review', summary: 'Staff review of a submitted visit (never the inspector)', permission: 'staff reports.review', params: idParams, body: siteVisitReviewSchema, response: siteVisitDtoSchema, auth: 'staff' }),
  op({ id: 'siteVisits.cancel', method: 'post', path: '/api/v1/site-visits/{id}/cancel', summary: 'Cancel a visit with a reason', permission: 'staff projects.manage', params: idParams, body: siteVisitCancelSchema, response: siteVisitDtoSchema, auth: 'staff' }),
  op({ id: 'siteVisits.evidence', method: 'get', path: '/api/v1/site-visits/{id}/evidence', summary: 'Evidence captured on a visit', permission: 'project read (customers: approved items and own uploads)', params: idParams, query: evidenceListQuerySchema, response: pageOf(evidenceDtoSchema) }),
  // Reports
  op({ id: 'projects.reports.list', method: 'get', path: '/api/v1/projects/{id}/reports', summary: 'Reports (customers: released only)', permission: 'project read / org.reports.view', params: idParams, query: reportListQuerySchema, response: pageOf(reportDtoSchema) }),
  op({ id: 'projects.reports.create', method: 'post', path: '/api/v1/projects/{id}/reports', summary: 'Draft a report', permission: 'staff reports.draft or assigned partner partner.reports.draft', params: idParams, body: reportCreateSchema, response: reportDetailDtoSchema, status: 201 }),
  op({ id: 'reports.get', method: 'get', path: '/api/v1/reports/{id}', summary: 'Report with revisions (customers: the released revision only)', permission: 'project read / org.reports.view', params: idParams, response: reportDetailDtoSchema }),
  op({ id: 'reports.revisions.create', method: 'post', path: '/api/v1/reports/{id}/revisions', summary: 'Add a revision (new version; a released revision stays frozen)', permission: 'reports.draft / partner.reports.draft', params: idParams, body: reportRevisionCreateSchema, response: reportDetailDtoSchema, status: 201 }),
  op({ id: 'reports.submit', method: 'post', path: '/api/v1/reports/{id}/submit', summary: 'Submit for review naming a professional reviewer who is not the author', permission: 'reports.draft / partner.reports.draft', params: idParams, body: reportSubmitSchema, response: reportDetailDtoSchema }),
  op({ id: 'reports.review', method: 'post', path: '/api/v1/reports/{id}/review', summary: 'Approve or request changes (never the author)', permission: 'staff reports.review', params: idParams, body: reportReviewSchema, response: reportDetailDtoSchema, auth: 'staff' }),
  op({ id: 'reports.release', method: 'post', path: '/api/v1/reports/{id}/release', summary: 'Release an approved report to the customer (never the author)', permission: 'staff reports.release', params: idParams, body: reportReleaseSchema, response: reportDetailDtoSchema, auth: 'staff' }),
  op({ id: 'reports.evidence', method: 'get', path: '/api/v1/reports/{id}/evidence', summary: 'Evidence referenced by a report', permission: 'project read / org.reports.view', params: idParams, response: items(evidenceDtoSchema) }),
  // Evidence
  op({ id: 'projects.evidence.list', method: 'get', path: '/api/v1/projects/{id}/evidence', summary: 'Evidence records (filter by visit, report, defect)', permission: 'project read (customers: approved items and own uploads)', params: idParams, query: evidenceListQuerySchema, response: pageOf(evidenceDtoSchema) }),
  op({ id: 'projects.evidence.link', method: 'post', path: '/api/v1/projects/{id}/evidence', summary: 'Link a scanned upload as evidence (capture time from the client, receipt time from the server)', permission: 'projects.manage, site_visits.perform, reports.draft, org.documents.upload or partner.evidence.upload', params: idParams, body: evidenceLinkSchema, response: evidenceMutationResponseSchema, status: 201 }),
  op({ id: 'projects.evidence.publication', method: 'post', path: '/api/v1/projects/{id}/evidence/{evidenceId}/publication', summary: 'Approve evidence for the customer or as a redacted public derivative', permission: 'staff evidence.approve (not own upload)', params: z.object({ id: uuidSchema, evidenceId: uuidSchema }), body: evidencePublicationUpdateSchema, response: evidenceDtoSchema, auth: 'staff' }),
  // Defects
  op({ id: 'projects.defects.list', method: 'get', path: '/api/v1/projects/{id}/defects', summary: 'Defects', permission: 'project read', params: idParams, query: defectListQuerySchema, response: pageOf(defectDtoSchema) }),
  op({ id: 'projects.defects.create', method: 'post', path: '/api/v1/projects/{id}/defects', summary: 'Raise a defect (numbered per project)', permission: 'projects.manage, site_visits.perform or partner.reports.draft', params: idParams, body: defectCreateSchema, response: defectDtoSchema, status: 201 }),
  op({ id: 'projects.unresolvedIssues', method: 'get', path: '/api/v1/projects/{id}/unresolved-issues', summary: 'Unresolved defects and open decisions', permission: 'project read', params: idParams, response: unresolvedIssuesDtoSchema }),
  op({ id: 'defects.get', method: 'get', path: '/api/v1/defects/{id}', summary: 'Defect detail', permission: 'project read', params: idParams, response: defectDtoSchema }),
  op({ id: 'defects.update', method: 'patch', path: '/api/v1/defects/{id}', summary: 'Update defect fields', permission: 'projects.manage, site_visits.perform or partner.reports.draft', params: idParams, body: defectUpdateSchema, response: defectDtoSchema }),
  op({ id: 'defects.transition', method: 'post', path: '/api/v1/defects/{id}/transitions', summary: 'Move a defect (verify requires reports.review/projects.manage and not the resolver)', permission: 'staff, assigned partner or customer (dispute) per transition', params: idParams, body: defectTransitionSchema, response: defectDtoSchema }),
  op({ id: 'defects.evidence', method: 'get', path: '/api/v1/defects/{id}/evidence', summary: 'Evidence attached to a defect', permission: 'project read', params: idParams, response: items(evidenceDtoSchema) }),
  // Change orders
  op({ id: 'projects.changeOrders.list', method: 'get', path: '/api/v1/projects/{id}/change-orders', summary: 'Change orders', permission: 'project read', params: idParams, query: changeOrderListQuerySchema, response: pageOf(changeOrderDtoSchema) }),
  op({ id: 'projects.changeOrders.create', method: 'post', path: '/api/v1/projects/{id}/change-orders', summary: 'Draft a change order', permission: 'staff projects.manage', params: idParams, body: changeOrderCreateSchema, response: changeOrderDtoSchema, status: 201, auth: 'staff' }),
  op({ id: 'changeOrders.get', method: 'get', path: '/api/v1/change-orders/{id}', summary: 'Change order with approvals', permission: 'project read', params: idParams, response: changeOrderDtoSchema }),
  op({ id: 'changeOrders.update', method: 'patch', path: '/api/v1/change-orders/{id}', summary: 'Edit a draft change order', permission: 'staff projects.manage', params: idParams, body: changeOrderUpdateSchema, response: changeOrderDtoSchema, auth: 'staff' }),
  op({ id: 'changeOrders.submit', method: 'post', path: '/api/v1/change-orders/{id}/submit', summary: 'Submit; creates pending approvals per policy', permission: 'staff projects.manage', params: idParams, body: changeOrderSubmitSchema, response: changeOrderDtoSchema, auth: 'staff' }),
  op({ id: 'changeOrders.approve', method: 'post', path: '/api/v1/change-orders/{id}/approve', summary: 'Customer or staff decision; the budget changes only when all required approvals exist', permission: 'org.change_orders.approve or staff change_orders.staff_approve (not the creator)', params: idParams, body: changeOrderDecisionSchema, response: changeOrderDtoSchema }),
  op({ id: 'changeOrders.withdraw', method: 'post', path: '/api/v1/change-orders/{id}/withdraw', summary: 'Creator withdraws before any decision', permission: 'staff projects.manage (creator only)', params: idParams, body: changeOrderWithdrawSchema, response: changeOrderDtoSchema, auth: 'staff' }),
  // Approvals
  op({ id: 'approvals.list', method: 'get', path: '/api/v1/approvals', summary: 'Approval records for an entity', permission: 'project read of the owning project', query: approvalsQuerySchema, response: items(approvalDtoSchema) }),
  op({ id: 'approvals.pending', method: 'get', path: '/api/v1/approvals/pending', summary: 'Pending approvals the caller can decide', permission: 'customer approver roles or staff change_orders.staff_approve/projects.manage', response: pendingApprovalsResponseSchema }),
  // Design options
  op({ id: 'projects.designOptions.list', method: 'get', path: '/api/v1/projects/{id}/design-options', summary: 'Design options with comments', permission: 'project read', params: idParams, response: items(designOptionDtoSchema) }),
  op({ id: 'projects.designOptions.create', method: 'post', path: '/api/v1/projects/{id}/design-options', summary: 'Create a design option with drawings', permission: 'staff projects.manage', params: idParams, body: designOptionCreateSchema, response: designOptionDtoSchema, status: 201, auth: 'staff' }),
  op({ id: 'designOptions.get', method: 'get', path: '/api/v1/design-options/{id}', summary: 'Design option detail', permission: 'project read', params: idParams, response: designOptionDtoSchema }),
  op({ id: 'designOptions.update', method: 'patch', path: '/api/v1/design-options/{id}', summary: 'Update a draft option (signed-off versions are immutable: 409)', permission: 'staff projects.manage', params: idParams, body: designOptionUpdateSchema, response: designOptionDtoSchema, auth: 'staff' }),
  op({ id: 'designOptions.comments.create', method: 'post', path: '/api/v1/design-options/{id}/comments', summary: 'Comment with a drawing anchor', permission: 'org.comment, staff or assigned partner', params: idParams, body: designCommentCreateSchema, response: designCommentDtoSchema, status: 201 }),
  op({ id: 'designOptions.comments.resolve', method: 'post', path: '/api/v1/design-options/{id}/comments/{commentId}/resolve', summary: 'Resolve a comment', permission: 'staff or the comment author', params: z.object({ id: uuidSchema, commentId: uuidSchema }), response: designCommentDtoSchema }),
  op({ id: 'designOptions.signOff', method: 'post', path: '/api/v1/design-options/{id}/sign-off', summary: 'Customer sign-off on this version (immutable afterwards)', permission: 'org.change_orders.approve', params: idParams, body: designSignOffSchema, response: designOptionDtoSchema }),
  op({ id: 'designOptions.versions.create', method: 'post', path: '/api/v1/design-options/{id}/versions', summary: 'New version superseding the current one', permission: 'staff projects.manage', params: idParams, body: designOptionNewVersionSchema, response: designOptionDtoSchema, status: 201, auth: 'staff' }),
  // Permits
  op({ id: 'projects.permits.list', method: 'get', path: '/api/v1/projects/{id}/permits', summary: 'Permit applications with events and elapsed time by court', permission: 'project read', params: idParams, response: items(permitDtoSchema) }),
  op({ id: 'projects.permits.create', method: 'post', path: '/api/v1/projects/{id}/permits', summary: 'Create a permit application (statutory target only with a source note)', permission: 'staff projects.manage', params: idParams, body: permitCreateSchema, response: permitDtoSchema, status: 201, auth: 'staff' }),
  op({ id: 'permits.get', method: 'get', path: '/api/v1/permits/{id}', summary: 'Permit application detail', permission: 'project read', params: idParams, response: permitDtoSchema }),
  op({ id: 'permits.update', method: 'patch', path: '/api/v1/permits/{id}', summary: 'Update application fields', permission: 'staff projects.manage', params: idParams, body: permitUpdateSchema, response: permitDtoSchema, auth: 'staff' }),
  op({ id: 'permits.events.create', method: 'post', path: '/api/v1/permits/{id}/events', summary: 'Append a permit event (append-only) and move the status', permission: 'staff projects.manage', params: idParams, body: permitEventCreateSchema, response: permitDtoSchema, status: 201, auth: 'staff' }),
];
