import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  currency,
  geometryPoint,
  id,
  jsonObject,
  jsonObjectNotNull,
  kobo,
  koboNotNull,
  koboZero,
  timestamps,
  tstz,
  version,
} from './_common';
import { organization, user } from './auth';
import { serviceRequests } from './crm';
import { markets, sources } from './geography';
import { properties } from './property';

export const projectKindEnum = pgEnum('project_kind', [
  'construction_monitoring',
  'architecture',
  'renovation',
  'snagging',
  'energy_water_upgrade',
  'quantity_surveying',
  'other',
]);

export const projectStatusEnum = pgEnum('project_status', [
  'planning',
  'active',
  'on_hold',
  'completed',
  'cancelled',
  'archived',
]);

export const budgetStatusEnum = pgEnum('budget_status', ['draft', 'approved', 'superseded']);
export const budgetSourceEnum = pgEnum('budget_source', ['area_rate', 'boq', 'quote', 'manual']);
export const commitmentKindEnum = pgEnum('commitment_kind', ['commitment', 'actual']);

export const schedulePhaseEnum = pgEnum('schedule_phase', [
  'design',
  'investigations',
  'approvals',
  'procurement',
  'site_preparation',
  'foundations',
  'structure',
  'roof',
  'services',
  'finishes',
  'inspection',
  'handover',
  'other',
]);

export const calendarBasisEnum = pgEnum('calendar_basis', ['working_days', 'calendar_days']);
export const dependencyTypeEnum = pgEnum('dependency_type', [
  'finish_to_start',
  'start_to_start',
  'finish_to_finish',
]);

export const accountablePartyEnum = pgEnum('accountable_party', [
  'customer',
  'simplexd',
  'contractor',
  'authority',
  'supplier',
  'consultant',
  'unknown',
]);

export const milestoneStatusEnum = pgEnum('milestone_status', [
  'pending',
  'in_progress',
  'submitted',
  'accepted',
  'rejected',
]);

export const siteVisitStatusEnum = pgEnum('site_visit_status', [
  'scheduled',
  'in_progress',
  'submitted',
  'reviewed',
  'cancelled',
]);

export const reportKindEnum = pgEnum('report_kind', [
  'progress',
  'inspection',
  'virtual_inspection',
  'diligence_memo',
  'design_deliverable',
  'valuation',
  'snagging',
  'feasibility',
  'existing_condition',
  'closing_pack',
  'search_outcome',
  'other',
]);

export const reportStatusEnum = pgEnum('report_status', [
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'released',
  'superseded',
]);

export const evidenceKindEnum = pgEnum('evidence_kind', [
  'photo',
  'video',
  'drone',
  'document',
  'audio',
  'drawing',
  'other',
]);

export const evidencePublicationEnum = pgEnum('evidence_publication', [
  'restricted',
  'approved',
  'redacted_public',
]);

export const defectSeverityEnum = pgEnum('defect_severity', [
  'cosmetic',
  'minor',
  'major',
  'critical',
  'safety',
]);

export const defectStatusEnum = pgEnum('defect_status', [
  'open',
  'acknowledged',
  'in_progress',
  'resolved',
  'verified',
  'closed',
  'disputed',
]);

export const changeOrderStatusEnum = pgEnum('change_order_status', [
  'draft',
  'submitted',
  'customer_review',
  'staff_review',
  'approved',
  'rejected',
  'withdrawn',
]);

export const approvalRoleEnum = pgEnum('approval_role', [
  'customer',
  'staff',
  'finance',
  'inspector',
  'data_approver',
  'second_approver',
]);

export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
  'withdrawn',
]);

export const permitStatusEnum = pgEnum('permit_status', [
  'preparing',
  'submitted',
  'query_raised',
  'resubmitted',
  'approved',
  'rejected',
  'withdrawn',
]);

export const dayBasisEnum = pgEnum('day_basis', ['elapsed', 'business']);

export const projects = pgTable(
  'projects',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    serviceRequestId: uuid().references(() => serviceRequests.id),
    propertyId: uuid().references(() => properties.id),
    marketId: uuid().references(() => markets.id),
    name: text().notNull(),
    kind: projectKindEnum().notNull(),
    status: projectStatusEnum().notNull().default('planning'),
    description: text(),
    approvedBudgetVersionId: uuid().references((): AnyPgColumn => budgetVersions.id),
    currentScheduleVersion: integer().notNull().default(1),
    startDate: date({ mode: 'string' }),
    targetCompletionDate: date({ mode: 'string' }),
    forecastCompletionDate: date({ mode: 'string' }),
    pmUserId: text().references(() => user.id),
    customerContactUserId: text().references(() => user.id),
    grossFloorAreaM2: numeric({ precision: 12, scale: 2 }),
    version: version(),
    createdBy: text().references(() => user.id),
    archivedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index('projects_org_idx').on(t.organizationId, t.status),
    index('projects_pm_idx').on(t.pmUserId),
  ],
);

export const budgetVersions = pgTable(
  'budget_versions',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    version: integer().notNull(),
    status: budgetStatusEnum().notNull().default('draft'),
    source: budgetSourceEnum().notNull().default('manual'),
    totalKobo: koboNotNull(),
    contingencyKobo: koboZero(),
    currency: currency(),
    buildRateKoboPerM2: kobo(),
    areaM2: numeric({ precision: 12, scale: 2 }),
    inclusions: text(),
    notes: text(),
    changeOrderId: uuid(),
    approvedByCustomerUserId: text().references(() => user.id),
    approvedByStaffUserId: text().references(() => user.id),
    approvedAt: tstz(),
    createdBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('budget_versions_unique').on(t.projectId, t.version)],
);

export const boqItems = pgTable(
  'boq_items',
  {
    id: id(),
    budgetVersionId: uuid()
      .notNull()
      .references(() => budgetVersions.id, { onDelete: 'cascade' }),
    code: text(),
    description: text().notNull(),
    category: text(),
    unit: text().notNull(),
    quantity: numeric({ precision: 14, scale: 3 }).notNull(),
    rateKobo: koboNotNull(),
    amountKobo: koboNotNull(),
    inclusions: text(),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [index('boq_items_budget_idx').on(t.budgetVersionId)],
);

export const budgetCommitments = pgTable(
  'budget_commitments',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    budgetVersionId: uuid().references(() => budgetVersions.id),
    boqItemId: uuid().references(() => boqItems.id),
    kind: commitmentKindEnum().notNull(),
    description: text().notNull(),
    amountKobo: koboNotNull(),
    currency: currency(),
    reference: text(),
    counterparty: text(),
    incurredAt: date({ mode: 'string' }),
    evidenceFileId: uuid(),
    createdBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [index('budget_commitments_project_idx').on(t.projectId, t.kind)],
);

export const scheduleTasks = pgTable(
  'schedule_tasks',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    scheduleVersion: integer().notNull().default(1),
    key: text().notNull(),
    name: text().notNull(),
    phase: schedulePhaseEnum().notNull().default('other'),
    durationDaysMin: integer(),
    durationDaysLikely: integer(),
    durationDaysMax: integer(),
    calendarBasis: calendarBasisEnum().notNull().default('working_days'),
    leadTimeDays: integer().notNull().default(0),
    plannedStart: date({ mode: 'string' }),
    plannedFinish: date({ mode: 'string' }),
    actualStart: date({ mode: 'string' }),
    actualFinish: date({ mode: 'string' }),
    percentComplete: integer().notNull().default(0),
    accountableParty: accountablePartyEnum().notNull().default('unknown'),
    assumptionNotes: text(),
    sourceNote: text(),
    isMilestone: boolean().notNull().default(false),
    sortOrder: integer().notNull().default(0),
    ...timestamps(),
  },
  (t) => [uniqueIndex('schedule_tasks_unique').on(t.projectId, t.scheduleVersion, t.key)],
);

export const taskDependencies = pgTable(
  'task_dependencies',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    scheduleVersion: integer().notNull().default(1),
    predecessorKey: text().notNull(),
    successorKey: text().notNull(),
    type: dependencyTypeEnum().notNull().default('finish_to_start'),
    lagDays: integer().notNull().default(0),
  },
  (t) => [
    uniqueIndex('task_dependencies_unique').on(
      t.projectId,
      t.scheduleVersion,
      t.predecessorKey,
      t.successorKey,
    ),
  ],
);

export const scheduleBaselines = pgTable(
  'schedule_baselines',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    version: integer().notNull(),
    snapshot: jsonb().notNull(),
    criticalPath: jsonObject<string[]>(),
    computedFinish: date({ mode: 'string' }),
    reason: text(),
    createdBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('schedule_baselines_unique').on(t.projectId, t.version)],
);

export const milestones = pgTable(
  'milestones',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    name: text().notNull(),
    description: text(),
    plannedDate: date({ mode: 'string' }),
    forecastDate: date({ mode: 'string' }),
    status: milestoneStatusEnum().notNull().default('pending'),
    inspectorProgressPct: integer(),
    inspectorProgressBy: text().references(() => user.id),
    inspectorProgressAt: tstz(),
    customerAcceptedBy: text().references(() => user.id),
    customerAcceptedAt: tstz(),
    customerRejectedReason: text(),
    financeAuthorizedBy: text().references(() => user.id),
    financeAuthorizedAt: tstz(),
    paymentInvoiceId: uuid(),
    sortOrder: integer().notNull().default(0),
    ...timestamps(),
  },
  (t) => [index('milestones_project_idx').on(t.projectId)],
);

export const siteVisits = pgTable(
  'site_visits',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    projectId: uuid().references(() => projects.id),
    propertyId: uuid().references(() => properties.id),
    serviceRequestId: uuid().references(() => serviceRequests.id),
    appointmentId: uuid(),
    scheduledAt: tstz(),
    inspectorUserId: text().references(() => user.id),
    status: siteVisitStatusEnum().notNull().default('scheduled'),
    instructions: text(),
    checklist: jsonb(),
    findingsMarkdown: text(),
    weather: text(),
    accessNote: text(),
    startedAt: tstz(),
    submittedAt: tstz(),
    reviewedBy: text().references(() => user.id),
    reviewedAt: tstz(),
    /** Client-generated id so offline resubmission is idempotent. */
    offlineClientId: text().unique(),
    ...timestamps(),
  },
  (t) => [
    index('site_visits_project_idx').on(t.projectId),
    index('site_visits_inspector_idx').on(t.inspectorUserId, t.status),
  ],
);

export const reports = pgTable(
  'reports',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    projectId: uuid().references(() => projects.id),
    serviceRequestId: uuid().references(() => serviceRequests.id),
    siteVisitId: uuid().references(() => siteVisits.id),
    kind: reportKindEnum().notNull(),
    title: text().notNull(),
    status: reportStatusEnum().notNull().default('draft'),
    currentVersion: integer().notNull().default(0),
    releasedVersion: integer(),
    releasedAt: tstz(),
    releasedBy: text().references(() => user.id),
    customerVisible: boolean().notNull().default(false),
    namedReviewerUserId: text().references(() => user.id),
    offlineClientId: text().unique(),
    createdBy: text().references(() => user.id),
    version: version(),
    ...timestamps(),
  },
  (t) => [
    index('reports_org_idx').on(t.organizationId, t.status),
    index('reports_project_idx').on(t.projectId),
    index('reports_sr_idx').on(t.serviceRequestId),
  ],
);

export interface ReportTemplateSection {
  key: string;
  heading: string;
  /** Guidance for the author; never shown to the customer. */
  guidance?: string;
  required: boolean;
}

/**
 * Section outlines for each report kind. Authors start a report from the
 * active template of its kind; the stored report keeps its own copy, so
 * editing a template never rewrites issued reports.
 */
export const reportTemplates = pgTable(
  'report_templates',
  {
    id: id(),
    kind: reportKindEnum().notNull(),
    name: text().notNull(),
    sections: jsonObjectNotNull<ReportTemplateSection[]>([]),
    /** Standard scope and limitations wording appended to the report. */
    limitationsMarkdown: text(),
    active: boolean().notNull().default(true),
    createdBy: text().references(() => user.id),
    version: version(),
    ...timestamps(),
  },
  (t) => [index('report_templates_kind_idx').on(t.kind, t.active)],
);

export const reportRevisions = pgTable(
  'report_revisions',
  {
    id: id(),
    reportId: uuid()
      .notNull()
      .references(() => reports.id),
    version: integer().notNull(),
    summary: text(),
    bodyMarkdown: text().notNull(),
    findings: jsonb(),
    attachmentFileIds: jsonObject<string[]>(),
    scopeLimitations: text(),
    reviewerUserId: text().references(() => user.id),
    reviewDecision: text(),
    reviewNote: text(),
    reviewedAt: tstz(),
    createdBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('report_revisions_unique').on(t.reportId, t.version)],
);

export const evidence = pgTable(
  'evidence',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    projectId: uuid().references(() => projects.id),
    serviceRequestId: uuid().references(() => serviceRequests.id),
    siteVisitId: uuid().references(() => siteVisits.id),
    reportId: uuid().references(() => reports.id),
    defectId: uuid(),
    workOrderId: uuid(),
    deliveryId: uuid(),
    fileId: uuid().notNull(),
    kind: evidenceKindEnum().notNull(),
    caption: text(),
    /** User-provided capture time; not proof of authenticity. */
    capturedAt: tstz(),
    captureGps: geometryPoint(),
    captureMetadata: jsonb(),
    uploaderUserId: text()
      .notNull()
      .references(() => user.id),
    receivedAt: createdAt(),
    checksumSha256: text().notNull(),
    publication: evidencePublicationEnum().notNull().default('restricted'),
    redactedFileId: uuid(),
    approvedBy: text().references(() => user.id),
    approvedAt: tstz(),
    offlineClientId: text().unique(),
    createdAt: createdAt(),
  },
  (t) => [
    index('evidence_project_idx').on(t.projectId),
    index('evidence_visit_idx').on(t.siteVisitId),
    index('evidence_report_idx').on(t.reportId),
  ],
);

export const defects = pgTable(
  'defects',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    projectId: uuid().references(() => projects.id),
    propertyId: uuid().references(() => properties.id),
    siteVisitId: uuid().references(() => siteVisits.id),
    reportId: uuid().references(() => reports.id),
    number: integer(),
    title: text().notNull(),
    description: text(),
    severity: defectSeverityEnum().notNull().default('minor'),
    status: defectStatusEnum().notNull().default('open'),
    accountableParty: accountablePartyEnum().notNull().default('unknown'),
    locationNote: text(),
    dueDate: date({ mode: 'string' }),
    aiSuggestedSeverity: text(),
    resolvedAt: tstz(),
    verifiedBy: text().references(() => user.id),
    verifiedAt: tstz(),
    createdBy: text().references(() => user.id),
    ...timestamps(),
  },
  (t) => [index('defects_project_idx').on(t.projectId, t.status)],
);

export const changeOrders = pgTable(
  'change_orders',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    baseBudgetVersionId: uuid().references(() => budgetVersions.id),
    number: integer().notNull(),
    title: text().notNull(),
    description: text(),
    amountDeltaKobo: koboNotNull(),
    scheduleDeltaDays: integer().notNull().default(0),
    status: changeOrderStatusEnum().notNull().default('draft'),
    requiresCustomerApproval: boolean().notNull().default(true),
    requiresStaffApproval: boolean().notNull().default(true),
    appliedBudgetVersionId: uuid().references(() => budgetVersions.id),
    submittedAt: tstz(),
    decidedAt: tstz(),
    decisionNote: text(),
    createdBy: text().references(() => user.id),
    version: version(),
    ...timestamps(),
  },
  (t) => [uniqueIndex('change_orders_number_unique').on(t.projectId, t.number)],
);

/** Generic approval records for milestones, change orders, reports, publications and payouts. */
export const approvals = pgTable(
  'approvals',
  {
    id: id(),
    organizationId: text().references(() => organization.id),
    entityType: text().notNull(),
    entityId: uuid().notNull(),
    approverRole: approvalRoleEnum().notNull(),
    approverUserId: text().references(() => user.id),
    status: approvalStatusEnum().notNull().default('pending'),
    decisionNote: text(),
    requestedBy: text().references(() => user.id),
    requestedAt: createdAt(),
    decidedAt: tstz(),
    expiresAt: tstz(),
  },
  (t) => [index('approvals_entity_idx').on(t.entityType, t.entityId, t.status)],
);

export const designOptions = pgTable(
  'design_options',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    title: text().notNull(),
    description: text(),
    drawingFileIds: jsonObject<string[]>(),
    version: integer().notNull().default(1),
    status: text().notNull().default('draft'),
    customerSignoffBy: text().references(() => user.id),
    customerSignoffAt: tstz(),
    createdBy: text().references(() => user.id),
    ...timestamps(),
  },
  (t) => [index('design_options_project_idx').on(t.projectId)],
);

export const designComments = pgTable(
  'design_comments',
  {
    id: id(),
    designOptionId: uuid()
      .notNull()
      .references(() => designOptions.id, { onDelete: 'cascade' }),
    authorUserId: text()
      .notNull()
      .references(() => user.id),
    body: text().notNull(),
    anchor: jsonb(),
    resolvedAt: tstz(),
    createdAt: createdAt(),
  },
  (t) => [index('design_comments_option_idx').on(t.designOptionId)],
);

export const permitApplications = pgTable(
  'permit_applications',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    projectId: uuid().references(() => projects.id),
    propertyId: uuid().references(() => properties.id),
    jurisdiction: text().notNull(),
    authority: text().notNull(),
    permitType: text().notNull(),
    documentType: text(),
    status: permitStatusEnum().notNull().default('preparing'),
    completenessDate: date({ mode: 'string' }),
    applicationReference: text(),
    feesKobo: kobo(),
    submittedAt: date({ mode: 'string' }),
    decidedAt: date({ mode: 'string' }),
    statutoryTargetDays: integer(),
    statutoryTargetBasis: dayBasisEnum(),
    statutorySourceNote: text(),
    notes: text(),
    ...timestamps(),
  },
  (t) => [index('permit_applications_project_idx').on(t.projectId)],
);

export const permitEvents = pgTable(
  'permit_events',
  {
    id: id(),
    permitApplicationId: uuid()
      .notNull()
      .references(() => permitApplications.id, { onDelete: 'cascade' }),
    eventType: text().notNull(),
    occurredAt: date({ mode: 'string' }).notNull(),
    note: text(),
    actorUserId: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [index('permit_events_application_idx').on(t.permitApplicationId)],
);

/** Observed historical approval durations with explicit start/end and day basis. */
export const approvalDurationObservations = pgTable(
  'approval_duration_observations',
  {
    id: id(),
    jurisdiction: text().notNull(),
    authority: text().notNull(),
    permitType: text().notNull(),
    marketId: uuid().references(() => markets.id),
    startedAt: date({ mode: 'string' }).notNull(),
    endedAt: date({ mode: 'string' }).notNull(),
    durationDays: integer().notNull(),
    dayBasis: dayBasisEnum().notNull(),
    sourceId: uuid().references(() => sources.id),
    projectId: uuid().references(() => projects.id),
    verificationStatus: text().notNull().default('source_read_pending_business_review'),
    note: text(),
    createdBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [index('approval_duration_obs_idx').on(t.jurisdiction, t.permitType)],
);

export const timelineTemplates = pgTable('timeline_templates', {
  id: id(),
  kind: text().notNull(),
  key: text().notNull().unique(),
  name: text().notNull(),
  status: text().notNull().default('demo_only'),
  tasks: jsonb().notNull(),
  dependencies: jsonb()
    .notNull()
    .default(sql`'[]'::jsonb`),
  assumptionNotes: text(),
  sourceNote: text(),
  missingInputs: jsonObject<string[]>(),
  createdBy: text().references(() => user.id),
  ...timestamps(),
});
