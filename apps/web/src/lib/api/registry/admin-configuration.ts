import { z } from 'zod';
import {
  documentRequirementCreateSchema,
  documentRequirementDtoSchema,
  documentRequirementListQuerySchema,
  documentRequirementPatchSchema,
  listRoutes,
  portfolioAnalyticsDtoSchema,
  portfolioAnalyticsQuerySchema,
  portfolioExportQuerySchema,
  priceAnchorCreateSchema,
  priceAnchorDraftSchema,
  priceAnchorDtoSchema,
  priceAnchorRetireSchema,
  priceAnchorTransitionSchema,
  quoteTemplateCreateSchema,
  quoteTemplateDtoSchema,
  quoteTemplateListQuerySchema,
  quoteTemplatePatchSchema,
  registerRoute,
  reportTemplateCreateSchema,
  reportTemplateDtoSchema,
  reportTemplateListQuerySchema,
  reportTemplatePatchSchema,
  slaPolicyCreateSchema,
  slaPolicyDtoSchema,
  slaPolicyPatchSchema,
  uuidSchema,
  type RouteSpec,
} from '@simplexd/contracts';

/**
 * OpenAPI registrations for admin configuration (price anchors, quotation
 * templates, report templates, document requirements, SLA policies) and
 * portfolio analytics. Registration is idempotent for hot reloads.
 */

const idParams = z.object({ id: uuidSchema });
const items = (item: z.ZodTypeAny) => z.object({ items: z.array(item) });

function register(spec: RouteSpec): void {
  if (listRoutes().some((r) => r.operationId === spec.operationId)) return;
  registerRoute(spec);
}

const pricingTags = ['Admin: pricing'];
const templateTags = ['Admin: templates'];
const analyticsTags = ['Admin: analytics'];

const specs: RouteSpec[] = [
  {
    method: 'get',
    path: '/api/v1/admin/price-anchors',
    summary: 'List service price anchors with open proposals',
    description:
      'Every service package with its live (published) anchor, publication state and the proposal under draft or review. Staff `pricing.manage`.',
    tags: pricingTags,
    operationId: 'adminListPriceAnchors',
    auth: 'staff',
    responses: { 200: { description: 'Anchors', body: items(priceAnchorDtoSchema) } },
  },
  {
    method: 'post',
    path: '/api/v1/admin/price-anchors',
    summary: 'Add a package as a draft proposal',
    description:
      'Creates the package unpublished and revision 1 as a draft. Amounts are integer kobo; percentage bases carry basis points. Staff `pricing.manage`.',
    tags: pricingTags,
    operationId: 'adminCreatePriceAnchor',
    auth: 'staff',
    request: { body: priceAnchorCreateSchema },
    responses: { 201: { description: 'Created anchor', body: priceAnchorDtoSchema } },
  },
  {
    method: 'get',
    path: '/api/v1/admin/price-anchors/{id}',
    summary: 'Get a price anchor with its revision history',
    tags: pricingTags,
    operationId: 'adminGetPriceAnchor',
    auth: 'staff',
    request: { params: idParams },
    responses: { 200: { description: 'Anchor with revisions', body: priceAnchorDtoSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/admin/price-anchors/{id}/draft',
    summary: 'Save a proposed change as a new draft revision',
    description:
      'Never overwrites the live anchor or earlier revisions. `expectedRevision` is the latest revision the editor saw (409 on conflict).',
    tags: pricingTags,
    operationId: 'adminSavePriceAnchorDraft',
    auth: 'staff',
    request: { params: idParams, body: priceAnchorDraftSchema },
    responses: { 200: { description: 'Anchor with the new draft', body: priceAnchorDtoSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/admin/price-anchors/{id}/transition',
    summary: 'Submit, publish, reject or withdraw a proposal',
    description:
      'Publish requires a pricing manager who did not draft or submit the proposal (separation of duties), a verified authenticator and a reason; it replaces the live anchor and appends a `published` revision. Reject also needs a different person; authors withdraw.',
    tags: pricingTags,
    operationId: 'adminTransitionPriceAnchor',
    auth: 'staff',
    request: { params: idParams, body: priceAnchorTransitionSchema },
    responses: { 200: { description: 'Anchor after the transition', body: priceAnchorDtoSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/admin/price-anchors/{id}/retire',
    summary: 'Retire a package from the public site',
    description: 'History is kept; a later proposal can publish it again. Verified authenticator and reason required.',
    tags: pricingTags,
    operationId: 'adminRetirePriceAnchor',
    auth: 'staff',
    request: { params: idParams, body: priceAnchorRetireSchema },
    responses: { 200: { description: 'Retired anchor', body: priceAnchorDtoSchema } },
  },
  {
    method: 'get',
    path: '/api/v1/admin/quote-templates',
    summary: 'List quotation templates',
    description: 'Per service or for every service. Staff `pricing.manage` or `quotes.issue`.',
    tags: templateTags,
    operationId: 'adminListQuoteTemplates',
    auth: 'staff',
    request: { query: quoteTemplateListQuerySchema },
    responses: { 200: { description: 'Templates', body: items(quoteTemplateDtoSchema) } },
  },
  {
    method: 'post',
    path: '/api/v1/admin/quote-templates',
    summary: 'Create a quotation template',
    description: 'Line amounts are recomputed from quantity × unit amount. Staff `pricing.manage`.',
    tags: templateTags,
    operationId: 'adminCreateQuoteTemplate',
    auth: 'staff',
    request: { body: quoteTemplateCreateSchema },
    responses: { 201: { description: 'Created template', body: quoteTemplateDtoSchema } },
  },
  {
    method: 'get',
    path: '/api/v1/admin/quote-templates/{id}',
    summary: 'Get a quotation template',
    tags: templateTags,
    operationId: 'adminGetQuoteTemplate',
    auth: 'staff',
    request: { params: idParams },
    responses: { 200: { description: 'Template', body: quoteTemplateDtoSchema } },
  },
  {
    method: 'patch',
    path: '/api/v1/admin/quote-templates/{id}',
    summary: 'Edit or deactivate a quotation template',
    description:
      'Quotes already drafted keep their own lines. `expectedUpdatedAt` is the concurrency token; a reason is recorded.',
    tags: templateTags,
    operationId: 'adminPatchQuoteTemplate',
    auth: 'staff',
    request: { params: idParams, body: quoteTemplatePatchSchema },
    responses: { 200: { description: 'Updated template', body: quoteTemplateDtoSchema } },
  },
  {
    method: 'get',
    path: '/api/v1/admin/report-templates',
    summary: 'List report templates',
    description: 'Ordered sections and limitations wording per report kind. Any report permission.',
    tags: templateTags,
    operationId: 'adminListReportTemplates',
    auth: 'staff',
    request: { query: reportTemplateListQuerySchema },
    responses: { 200: { description: 'Templates', body: items(reportTemplateDtoSchema) } },
  },
  {
    method: 'post',
    path: '/api/v1/admin/report-templates',
    summary: 'Create a report template',
    description:
      'At most one template per kind is active: creating an active one deactivates the previous. Staff `reports.review`.',
    tags: templateTags,
    operationId: 'adminCreateReportTemplate',
    auth: 'staff',
    request: { body: reportTemplateCreateSchema },
    responses: { 201: { description: 'Created template', body: reportTemplateDtoSchema } },
  },
  {
    method: 'get',
    path: '/api/v1/admin/report-templates/{id}',
    summary: 'Get a report template',
    tags: templateTags,
    operationId: 'adminGetReportTemplate',
    auth: 'staff',
    request: { params: idParams },
    responses: { 200: { description: 'Template', body: reportTemplateDtoSchema } },
  },
  {
    method: 'patch',
    path: '/api/v1/admin/report-templates/{id}',
    summary: 'Edit or activate a report template',
    description: 'Activating deactivates the kind’s other template. `expectedVersion` and a reason are required.',
    tags: templateTags,
    operationId: 'adminPatchReportTemplate',
    auth: 'staff',
    request: { params: idParams, body: reportTemplatePatchSchema },
    responses: { 200: { description: 'Updated template', body: reportTemplateDtoSchema } },
  },
  {
    method: 'get',
    path: '/api/v1/admin/document-requirements',
    summary: 'List document requirements',
    description: 'Per service, or `serviceId=all` for requirements that apply to every service.',
    tags: templateTags,
    operationId: 'adminListDocumentRequirements',
    auth: 'staff',
    request: { query: documentRequirementListQuerySchema },
    responses: { 200: { description: 'Requirements', body: items(documentRequirementDtoSchema) } },
  },
  {
    method: 'post',
    path: '/api/v1/admin/document-requirements',
    summary: 'Add a document requirement',
    description:
      'Sensitive (identity) documents are shown to customers only inside their own request and never on public pages. Staff `pricing.manage`.',
    tags: templateTags,
    operationId: 'adminCreateDocumentRequirement',
    auth: 'staff',
    request: { body: documentRequirementCreateSchema },
    responses: { 201: { description: 'Created requirement', body: documentRequirementDtoSchema } },
  },
  {
    method: 'patch',
    path: '/api/v1/admin/document-requirements/{id}',
    summary: 'Edit a document requirement',
    tags: templateTags,
    operationId: 'adminPatchDocumentRequirement',
    auth: 'staff',
    request: { params: idParams, body: documentRequirementPatchSchema },
    responses: { 200: { description: 'Updated requirement', body: documentRequirementDtoSchema } },
  },
  {
    method: 'get',
    path: '/api/v1/admin/sla-policies',
    summary: 'List SLA policies',
    description: 'Target hours per engagement stage, per service or global. Staff `sla.manage` or `service_requests.read_all`.',
    tags: templateTags,
    operationId: 'adminListSlaPolicies',
    auth: 'staff',
    responses: { 200: { description: 'Policies', body: items(slaPolicyDtoSchema) } },
  },
  {
    method: 'post',
    path: '/api/v1/admin/sla-policies',
    summary: 'Add an SLA policy',
    description: 'One active policy per service (or global) and stage; the service-specific policy wins at triage. Staff `sla.manage`.',
    tags: templateTags,
    operationId: 'adminCreateSlaPolicy',
    auth: 'staff',
    request: { body: slaPolicyCreateSchema },
    responses: { 201: { description: 'Created policy', body: slaPolicyDtoSchema } },
  },
  {
    method: 'patch',
    path: '/api/v1/admin/sla-policies/{id}',
    summary: 'Edit an SLA policy',
    tags: templateTags,
    operationId: 'adminPatchSlaPolicy',
    auth: 'staff',
    request: { params: idParams, body: slaPolicyPatchSchema },
    responses: { 200: { description: 'Updated policy', body: slaPolicyDtoSchema } },
  },
  {
    method: 'get',
    path: '/api/v1/admin/analytics/portfolio',
    summary: 'Portfolio analytics derived from records',
    description:
      'Properties and occupancy, rent arrears, active project budgets, open change orders, service requests with SLA state and revenue by month. Each section is returned only to actors with its permission; project managers see their assigned projects and requests. Point-in-time sections are as at the range end.',
    tags: analyticsTags,
    operationId: 'adminPortfolioAnalytics',
    auth: 'staff',
    request: { query: portfolioAnalyticsQuerySchema },
    responses: { 200: { description: 'Analytics', body: portfolioAnalyticsDtoSchema } },
  },
  {
    method: 'get',
    path: '/api/v1/admin/analytics/portfolio/export',
    summary: 'Export the rows behind one analytics section (CSV)',
    description:
      'Lists the records each figure was summed from, so a spreadsheet total reproduces the page. Arrears and revenue also need `finance.export` (verified authenticator). Every export is audited.',
    tags: analyticsTags,
    operationId: 'adminPortfolioAnalyticsExport',
    auth: 'staff',
    request: { query: portfolioExportQuerySchema },
    responses: { 200: { description: 'CSV file' } },
  },
];

for (const spec of specs) register(spec);

export const adminConfigurationRouteSpecs: readonly RouteSpec[] = specs;
