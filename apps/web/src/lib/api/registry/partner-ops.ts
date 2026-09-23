import { z } from 'zod';
import {
  conversationDetailSchema,
  discrepancyDecideSchema,
  discrepancyRespondSchema,
  discrepancyThreadDtoSchema,
  discrepancyThreadsResponseSchema,
  listRoutes,
  pageOf,
  partnerConversationCreateSchema,
  partnerConversationResponseSchema,
  partnerInvoiceAcceptSchema,
  partnerInvoiceDtoSchema,
  partnerInvoiceFailSchema,
  partnerInvoiceListQuerySchema,
  partnerInvoiceRejectSchema,
  partnerInvoiceSecondApproveSchema,
  partnerInvoiceSettleSchema,
  partnerInvoiceSubmitSchema,
  registerRoute,
  reviewersQuerySchema,
  reviewersResponseSchema,
  siteVisitMutationResponseSchema,
  siteVisitRejectSchema,
  siteVisitUnscheduledStartSchema,
  uuidSchema,
  type RouteSpec,
} from '@simplexd/contracts';

/**
 * OpenAPI registrations for the partner-workspace operations: supplier
 * responses to delivery discrepancies, unscheduled site visits, the reviewer
 * directory, partner-initiated conversations and partner invoices. Route
 * handlers import this module for its side effect; registration is
 * idempotent so hot reloads never trip the duplicate-operation guard.
 */

export const partnerOpsIdParams = z.object({ id: uuidSchema });
export const partnerOpsDiscrepancyParams = z.object({ id: uuidSchema, did: uuidSchema });

function ensure(spec: RouteSpec): RouteSpec {
  const existing = listRoutes().find((r) => r.operationId === spec.operationId);
  return existing ?? registerRoute(spec);
}

const FEATURE_PROCUREMENT = 'Feature flag: expansion.materials_procurement.';
const invoiceTags = ['Partner invoices'];

const specs: RouteSpec[] = [
  /* --------------------------- discrepancy responses --------------------------- */
  {
    method: 'get',
    path: '/api/v1/deliveries/{id}/discrepancy-threads',
    summary: 'Discrepancy threads of a delivery',
    description: `Each discrepancy with the supplier's responses (proposed resolution, evidence) and staff decisions. Staff, the supplier named on the order, or the ordering organisation. ${FEATURE_PROCUREMENT}`,
    tags: ['Procurement'],
    operationId: 'deliveries.discrepancyThreads.list',
    auth: 'session',
    request: { params: partnerOpsIdParams },
    responses: { 200: { description: 'Threads', body: discrepancyThreadsResponseSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/deliveries/{id}/discrepancies/{did}/respond',
    summary: 'Supplier responds to a discrepancy',
    description: `The supplier named on the order (partner.deliveries.view) replies with a response, a proposed resolution (replace, credit or dispute) and their own scanned files, which are linked as delivery evidence. An open discrepancy becomes supplier_notified; staff are told. ${FEATURE_PROCUREMENT}`,
    tags: ['Procurement'],
    operationId: 'deliveries.discrepancies.respond',
    auth: 'partner',
    request: { params: partnerOpsDiscrepancyParams, body: discrepancyRespondSchema },
    responses: { 200: { description: 'Thread', body: discrepancyThreadDtoSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/deliveries/{id}/discrepancies/{did}/decide',
    summary: 'Staff accept or reject the supplier response',
    description: `procurement.manage; needs a supplier response awaiting a decision. Accept closes the discrepancy (resolved, credited or returned; defaults from the proposal) with the reason as resolution note; reject keeps it open for another response. The supplier is told. ${FEATURE_PROCUREMENT}`,
    tags: ['Procurement'],
    operationId: 'deliveries.discrepancies.decide',
    auth: 'staff',
    request: { params: partnerOpsDiscrepancyParams, body: discrepancyDecideSchema },
    responses: { 200: { description: 'Thread', body: discrepancyThreadDtoSchema } },
  },
  /* ---------------------------- unscheduled visits ----------------------------- */
  {
    method: 'post',
    path: '/api/v1/projects/{id}/site-visits/unscheduled',
    summary: 'Start an unscheduled site visit',
    description:
      'Staff with site_visits.perform, or a partner holding an accepted/active field assignment (inspector, surveyor, valuer, architect, quantity surveyor, contractor) on the project. Reason required; the visit starts in_progress with no scheduled time, is flagged unscheduled and the project manager is notified. Idempotent on offlineClientId.',
    tags: ['Projects'],
    operationId: 'projects.siteVisits.startUnscheduled',
    auth: 'session',
    request: { params: partnerOpsIdParams, body: siteVisitUnscheduledStartSchema },
    responses: {
      201: { description: 'Visit', body: siteVisitMutationResponseSchema },
      200: { description: 'Replayed', body: siteVisitMutationResponseSchema },
    },
  },
  {
    method: 'post',
    path: '/api/v1/site-visits/{id}/reject',
    summary: 'Reject an unscheduled visit',
    description:
      'projects.manage or reports.review on the project; only unscheduled visits that are in progress or submitted (never reviewed ones, never by the inspector who performed it). Reason required; the inspector is notified.',
    tags: ['Projects'],
    operationId: 'siteVisits.reject',
    auth: 'staff',
    request: { params: partnerOpsIdParams, body: siteVisitRejectSchema },
    responses: {
      200: {
        description: 'Visit',
        body: siteVisitMutationResponseSchema.omit({ idempotentReplay: true }),
      },
    },
  },
  /* ------------------------------- reviewers ---------------------------------- */
  {
    method: 'get',
    path: '/api/v1/reviewers',
    summary: 'Staff eligible to review reports',
    description:
      'Users holding an active staff role that carries reports.review, minus the requester. Staff and partners only (customers are refused). Fields: id, name, role, isProjectManager (when projectId is given and visible to the caller).',
    tags: ['Projects'],
    operationId: 'reviewers.list',
    auth: 'session',
    request: { query: reviewersQuerySchema },
    responses: { 200: { description: 'Reviewers', body: reviewersResponseSchema } },
  },
  /* -------------------------- partner conversations ---------------------------- */
  {
    method: 'post',
    path: '/api/v1/conversations/partner',
    summary: 'Partner starts a conversation with the SimplexD team',
    description:
      'Partner accounts only, about a project or service request they are assigned to, a tender they were invited to, or an RFQ/purchase order naming them. The server adds the staff attached to the record (project manager, coordinators, issuer) or, failing that, the operations managers; customers are never added. Creates a `partner` conversation with the first message.',
    tags: ['Collaboration'],
    operationId: 'conversations.partner.create',
    auth: 'partner',
    request: { body: partnerConversationCreateSchema },
    responses: { 201: { description: 'Conversation', body: partnerConversationResponseSchema } },
  },
  /* ----------------------------- partner invoices ------------------------------ */
  {
    method: 'get',
    path: '/api/v1/partner-invoices',
    summary: 'List partner invoices',
    description:
      'Partners: their own submissions. Staff (finance.read): all, filterable by status, partner and organisation. Customers are refused.',
    tags: invoiceTags,
    operationId: 'partnerInvoices.list',
    auth: 'session',
    request: { query: partnerInvoiceListQuerySchema },
    responses: { 200: { description: 'Invoices', body: pageOf(partnerInvoiceDtoSchema) } },
  },
  {
    method: 'post',
    path: '/api/v1/partner-invoices',
    summary: 'Submit a partner invoice',
    description:
      'partner.invoices.submit. Against a purchase order issued to the partner (invoices may not exceed the order total) or a completed assignment; the attachment must be the partner’s own scanned file; the reference is unique per partner. Recorded as a proposed payout of kind partner_invoice; finance is notified.',
    tags: invoiceTags,
    operationId: 'partnerInvoices.submit',
    auth: 'partner',
    request: { body: partnerInvoiceSubmitSchema },
    responses: { 201: { description: 'Invoice', body: partnerInvoiceDtoSchema } },
  },
  {
    method: 'get',
    path: '/api/v1/partner-invoices/{id}',
    summary: 'Partner invoice detail with history',
    tags: invoiceTags,
    operationId: 'partnerInvoices.get',
    auth: 'session',
    request: { params: partnerOpsIdParams },
    responses: { 200: { description: 'Invoice', body: partnerInvoiceDtoSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/partner-invoices/{id}/accept',
    summary: 'Finance accepts the invoice (first approval)',
    description:
      'finance.payouts.first_approve (verified authenticator). proposed → first_approved; posts the payable (Dr 5200 materials or 5300 professional fees / Cr 2400). Payment still needs a second approver.',
    tags: invoiceTags,
    operationId: 'partnerInvoices.accept',
    auth: 'staff',
    request: { params: partnerOpsIdParams, body: partnerInvoiceAcceptSchema },
    responses: { 200: { description: 'Invoice', body: partnerInvoiceDtoSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/partner-invoices/{id}/reject',
    summary: 'Finance rejects the invoice',
    description:
      'finance.payouts.first_approve; proposed or first_approved → rejected with a reason. A payable already posted is reversed.',
    tags: invoiceTags,
    operationId: 'partnerInvoices.reject',
    auth: 'staff',
    request: { params: partnerOpsIdParams, body: partnerInvoiceRejectSchema },
    responses: { 200: { description: 'Invoice', body: partnerInvoiceDtoSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/partner-invoices/{id}/second-approve',
    summary: 'Second approval by a different approver',
    description:
      'finance.payouts.second_approve; first_approved → approved (or failed → approved with a reason). Nothing is posted; the transfer may now be submitted.',
    tags: invoiceTags,
    operationId: 'partnerInvoices.secondApprove',
    auth: 'staff',
    request: { params: partnerOpsIdParams, body: partnerInvoiceSecondApproveSchema },
    responses: { 200: { description: 'Invoice', body: partnerInvoiceDtoSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/partner-invoices/{id}/submit-payment',
    summary: 'Mark the transfer submitted to the bank',
    description: 'finance.reconcile; approved → submitted.',
    tags: invoiceTags,
    operationId: 'partnerInvoices.submitPayment',
    auth: 'staff',
    request: { params: partnerOpsIdParams },
    responses: { 200: { description: 'Invoice', body: partnerInvoiceDtoSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/partner-invoices/{id}/settle',
    summary: 'Record settlement against the bank statement',
    description:
      'finance.reconcile; submitted → settled with the bank reference; posts Dr 2400 / Cr 1000.',
    tags: invoiceTags,
    operationId: 'partnerInvoices.settle',
    auth: 'staff',
    request: { params: partnerOpsIdParams, body: partnerInvoiceSettleSchema },
    responses: { 200: { description: 'Invoice', body: partnerInvoiceDtoSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/partner-invoices/{id}/fail',
    summary: 'Mark the transfer failed',
    description:
      'finance.reconcile; submitted → failed with a reason; a second approver can re-approve.',
    tags: invoiceTags,
    operationId: 'partnerInvoices.fail',
    auth: 'staff',
    request: { params: partnerOpsIdParams, body: partnerInvoiceFailSchema },
    responses: { 200: { description: 'Invoice', body: partnerInvoiceDtoSchema } },
  },
];

for (const spec of specs) ensure(spec);

export const partnerOpsRouteCount = specs.length;
export { conversationDetailSchema as partnerConversationDetailSchema };
