import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  currency,
  id,
  jsonObject,
  kobo,
  koboNotNull,
  timestamps,
  tstz,
  version,
} from './_common';
import { organization, user } from './auth';
import { markets, publicationStateEnum, serviceAvailabilityEnum } from './geography';
import { scenarios } from './intelligence';

export const serviceCategoryEnum = pgEnum('service_category', ['core', 'expansion']);

export const priceBasisEnum = pgEnum('price_basis', [
  'fixed',
  'from',
  'per_month',
  'percentage',
  'quotation',
]);

export const packagePublicationEnum = pgEnum('package_publication', [
  'draft',
  'in_review',
  'published',
  'retired',
]);

export const leadSourceEnum = pgEnum('lead_source', [
  'website_form',
  'consultation_booking',
  'map_scenario',
  'referral',
  'manual',
  'quote_request',
]);

export const leadStatusEnum = pgEnum('lead_status', [
  'new',
  'contacted',
  'qualified',
  'converted',
  'closed_lost',
  'spam',
]);

export const engagementStatusEnum = pgEnum('engagement_status', [
  'inquiry',
  'triage',
  'quoted',
  'accepted',
  'awaiting_payment',
  'in_progress',
  'in_review',
  'delivered',
  'completed',
  'rejected',
  'paused',
  'cancelled',
]);

export const quoteStatusEnum = pgEnum('quote_status', [
  'draft',
  'issued',
  'accepted',
  'rejected',
  'expired',
  'superseded',
  'withdrawn',
]);

export const assignmentRoleEnum = pgEnum('assignment_role', [
  'project_manager',
  'inspector',
  'surveyor',
  'legal',
  'architect',
  'quantity_surveyor',
  'contractor',
  'vendor',
  'valuer',
  'agent',
  'support',
  'coordinator',
  'other',
]);

export const assignmentStatusEnum = pgEnum('assignment_status', [
  'proposed',
  'accepted',
  'declined',
  'active',
  'completed',
  'revoked',
]);

export const taskStatusEnum = pgEnum('task_status', [
  'todo',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
]);

export const visibilityEnum = pgEnum('visibility', ['internal', 'customer', 'partner', 'all']);

export const services = pgTable(
  'services',
  {
    id: id(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    category: serviceCategoryEnum().notNull().default('core'),
    shortDescription: text().notNull(),
    descriptionMarkdown: text(),
    deliverables: jsonObject<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    completionEvidence: text(),
    workflowTemplateKey: text().notNull(),
    featureFlagKey: text(),
    bookingEnabled: boolean().notNull().default(false),
    inquiryEnabled: boolean().notNull().default(true),
    staffed: boolean().notNull().default(false),
    regulatedGated: boolean().notNull().default(false),
    commercialModel: text(),
    sortOrder: integer().notNull().default(0),
    iconKey: text(),
    publicationState: publicationStateEnum().notNull().default('draft'),
    version: version(),
    ...timestamps(),
  },
  (t) => [index('services_category_idx').on(t.category, t.sortOrder)],
);

export const servicePackages = pgTable(
  'service_packages',
  {
    id: id(),
    serviceId: uuid()
      .notNull()
      .references(() => services.id),
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    scopeMarkdown: text(),
    priceBasis: priceBasisEnum().notNull(),
    amountKobo: kobo(),
    percentageBps: integer(),
    currency: currency(),
    minimumScope: text(),
    exclusions: text(),
    effectiveFrom: date({ mode: 'string' }),
    effectiveTo: date({ mode: 'string' }),
    publicationState: packagePublicationEnum().notNull().default('draft'),
    reviewedBy: text().references(() => user.id),
    reviewedAt: tstz(),
    publishedAt: tstz(),
    version: version(),
    createdBy: text().references(() => user.id),
    updatedBy: text().references(() => user.id),
    ...timestamps(),
  },
  (t) => [uniqueIndex('service_packages_slug_unique').on(t.serviceId, t.slug)],
);

export const servicePackageRevisions = pgTable(
  'service_package_revisions',
  {
    id: id(),
    packageId: uuid()
      .notNull()
      .references(() => servicePackages.id),
    version: integer().notNull(),
    snapshot: jsonb().notNull(),
    reason: text(),
    changedBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('service_package_revisions_unique').on(t.packageId, t.version)],
);

/** Service availability per market, independent of map coverage. */
export const serviceCoverage = pgTable(
  'service_coverage',
  {
    id: id(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id),
    serviceId: uuid()
      .notNull()
      .references(() => services.id),
    availability: serviceAvailabilityEnum().notNull(),
    note: text(),
    effectiveFrom: date({ mode: 'string' }),
    effectiveTo: date({ mode: 'string' }),
    updatedBy: text().references(() => user.id),
    ...timestamps(),
  },
  (t) => [uniqueIndex('service_coverage_unique').on(t.marketId, t.serviceId)],
);

export const leads = pgTable(
  'leads',
  {
    id: id(),
    organizationId: text().references(() => organization.id),
    userId: text().references(() => user.id),
    contactName: text().notNull(),
    email: text().notNull(),
    phoneE164: text(),
    countryOfResidence: text(),
    timeZone: text(),
    source: leadSourceEnum().notNull(),
    interestServiceId: uuid().references(() => services.id),
    goal: text(),
    message: text(),
    scenarioId: uuid().references(() => scenarios.id),
    context: jsonb(),
    status: leadStatusEnum().notNull().default('new'),
    assignedToUserId: text().references(() => user.id),
    convertedServiceRequestId: uuid(),
    marketingConsent: boolean().notNull().default(false),
    consentPolicyVersion: text(),
    ipHash: text(),
    userAgent: text(),
    ...timestamps(),
  },
  (t) => [
    index('leads_status_idx').on(t.status, t.createdAt),
    index('leads_email_idx').on(t.email),
  ],
);

export const serviceRequests = pgTable(
  'service_requests',
  {
    id: id(),
    reference: text().notNull().unique(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    requestedByUserId: text()
      .notNull()
      .references(() => user.id),
    serviceId: uuid()
      .notNull()
      .references(() => services.id),
    packageId: uuid().references(() => servicePackages.id),
    title: text().notNull(),
    description: text(),
    status: engagementStatusEnum().notNull().default('inquiry'),
    marketId: uuid().references(() => markets.id),
    propertyId: uuid(),
    projectId: uuid(),
    scenarioId: uuid().references(() => scenarios.id),
    leadId: uuid().references(() => leads.id),
    priority: integer().notNull().default(3),
    assignedPmUserId: text().references(() => user.id),
    slaDueAt: tstz(),
    context: jsonb(),
    /** For percentage-based services: agreed percentage basis and signed scope reference. */
    feeBasis: jsonObject<{
      percentageBps?: number;
      basisDescription?: string;
      signedScopeFileId?: string;
      agreedAt?: string;
    }>(),
    pauseReason: text(),
    cancelReason: text(),
    rejectReason: text(),
    completedAt: tstz(),
    feedbackRating: integer(),
    feedbackComment: text(),
    version: version(),
    ...timestamps(),
  },
  (t) => [
    index('service_requests_org_idx').on(t.organizationId, t.status),
    index('service_requests_service_idx').on(t.serviceId, t.status),
    index('service_requests_pm_idx').on(t.assignedPmUserId),
  ],
);

export const engagementTransitions = pgTable(
  'engagement_transitions',
  {
    id: id(),
    serviceRequestId: uuid()
      .notNull()
      .references(() => serviceRequests.id),
    fromStatus: engagementStatusEnum(),
    toStatus: engagementStatusEnum().notNull(),
    actorUserId: text().references(() => user.id),
    actorType: text().notNull().default('user'),
    reason: text(),
    metadata: jsonb(),
    createdAt: createdAt(),
  },
  (t) => [index('engagement_transitions_sr_idx').on(t.serviceRequestId, t.createdAt)],
);

export const quotes = pgTable(
  'quotes',
  {
    id: id(),
    serviceRequestId: uuid()
      .notNull()
      .references(() => serviceRequests.id),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    status: quoteStatusEnum().notNull().default('draft'),
    currentVersion: integer().notNull().default(0),
    createdBy: text().references(() => user.id),
    ...timestamps(),
  },
  (t) => [index('quotes_sr_idx').on(t.serviceRequestId)],
);

export interface QuoteLine {
  description: string;
  quantity: string;
  unitAmountKobo: string;
  amountKobo: string;
  taxRateBps?: number;
  accountCode?: string;
}

export const quoteVersions = pgTable(
  'quote_versions',
  {
    id: id(),
    quoteId: uuid()
      .notNull()
      .references(() => quotes.id),
    version: integer().notNull(),
    lines: jsonObject<QuoteLine[]>().notNull(),
    subtotalKobo: koboNotNull(),
    taxKobo: koboNotNull(),
    totalKobo: koboNotNull(),
    currency: currency(),
    scopeMarkdown: text(),
    exclusions: text(),
    validUntil: tstz(),
    feeBasis: jsonb(),
    taxTreatmentKey: text(),
    issuedAt: tstz(),
    issuedBy: text().references(() => user.id),
    pdfFileId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('quote_versions_unique').on(t.quoteId, t.version)],
);

export const acceptances = pgTable('acceptances', {
  id: id(),
  quoteVersionId: uuid()
    .notNull()
    .unique()
    .references(() => quoteVersions.id),
  acceptedByUserId: text()
    .notNull()
    .references(() => user.id),
  acceptedAt: createdAt(),
  ipHash: text(),
  userAgent: text(),
  signatureName: text().notNull(),
  termsVersion: text().notNull(),
});

export const assignments = pgTable(
  'assignments',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    serviceRequestId: uuid().references(() => serviceRequests.id),
    projectId: uuid(),
    assigneeUserId: text()
      .notNull()
      .references(() => user.id),
    role: assignmentRoleEnum().notNull(),
    status: assignmentStatusEnum().notNull().default('proposed'),
    instructions: text(),
    startsAt: tstz(),
    endsAt: tstz(),
    assignedBy: text().references(() => user.id),
    respondedAt: tstz(),
    revokedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index('assignments_assignee_idx').on(t.assigneeUserId, t.status),
    index('assignments_sr_idx').on(t.serviceRequestId),
    index('assignments_project_idx').on(t.projectId),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    serviceRequestId: uuid().references(() => serviceRequests.id),
    projectId: uuid(),
    assignmentId: uuid().references(() => assignments.id),
    workOrderId: uuid(),
    title: text().notNull(),
    description: text(),
    status: taskStatusEnum().notNull().default('todo'),
    dueAt: tstz(),
    assigneeUserId: text().references(() => user.id),
    visibility: visibilityEnum().notNull().default('internal'),
    requiresCustomerAction: boolean().notNull().default(false),
    completedAt: tstz(),
    completedBy: text().references(() => user.id),
    createdBy: text().references(() => user.id),
    ...timestamps(),
  },
  (t) => [
    index('tasks_org_idx').on(t.organizationId, t.status),
    index('tasks_assignee_idx').on(t.assigneeUserId, t.status),
  ],
);

export const slaPolicies = pgTable('sla_policies', {
  id: id(),
  serviceId: uuid().references(() => services.id),
  stage: engagementStatusEnum().notNull(),
  targetHours: integer().notNull(),
  businessHoursOnly: boolean().notNull().default(true),
  escalateToRole: text(),
  active: boolean().notNull().default(true),
  ...timestamps(),
});

export const notes = pgTable(
  'notes',
  {
    id: id(),
    organizationId: text().references(() => organization.id),
    entityType: text().notNull(),
    entityId: uuid().notNull(),
    body: text().notNull(),
    visibility: visibilityEnum().notNull().default('internal'),
    authorUserId: text()
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [index('notes_entity_idx').on(t.entityType, t.entityId)],
);

export const quoteTemplates = pgTable('quote_templates', {
  id: id(),
  serviceId: uuid().references(() => services.id),
  name: text().notNull(),
  lines: jsonObject<QuoteLine[]>().notNull(),
  scopeMarkdown: text(),
  exclusions: text(),
  active: boolean().notNull().default(true),
  createdBy: text().references(() => user.id),
  ...timestamps(),
});
