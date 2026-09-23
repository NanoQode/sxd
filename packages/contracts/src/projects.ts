import { z } from 'zod';
import {
  cursorPaginationQuerySchema,
  dateOnlySchema,
  decimalStringSchema,
  expectedVersionSchema,
  isoDateTimeSchema,
  uuidSchema,
} from './common';

/**
 * Project delivery engine contracts: projects, budgets/BOQ/commitments,
 * schedule, milestones, site visits (with offline sync), reports and
 * revisions, evidence, defects, change orders, approvals, design options and
 * permit applications. Money is integer kobo as decimal strings, dates are
 * ISO strings (calendar dates as YYYY-MM-DD), points are `{ lon, lat }`.
 */

/* ---------------------------------------------------------------------- */
/* Shared primitives                                                       */
/* ---------------------------------------------------------------------- */

export const koboStringSchema = z.string().regex(/^-?\d+$/, 'integer kobo as a string');
export const nonNegativeKoboStringSchema = z.string().regex(/^\d+$/, 'non-negative integer kobo');
/** WGS84 capture position with range checks (the shared lonLatSchema in markets.ts is unbounded). */
export const captureGpsSchema = z.object({
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});
export type CaptureGpsDto = z.infer<typeof captureGpsSchema>;

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

/** Client-generated id for offline-first submissions; the same id replays instead of duplicating. */
export const offlineClientIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/, 'offline client id: 8-128 url-safe characters');

export const idParamsSchema = z.object({ id: uuidSchema });

/* ---------------------------------------------------------------------- */
/* Enumerations (mirror packages/db/src/schema/project.ts)                  */
/* ---------------------------------------------------------------------- */

export const projectKindSchema = z.enum([
  'construction_monitoring',
  'architecture',
  'renovation',
  'snagging',
  'energy_water_upgrade',
  'quantity_surveying',
  'other',
]);
export type ProjectKind = z.infer<typeof projectKindSchema>;

export const projectStatusSchema = z.enum([
  'planning',
  'active',
  'on_hold',
  'completed',
  'cancelled',
  'archived',
]);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const budgetStatusSchema = z.enum(['draft', 'approved', 'superseded']);
export const budgetSourceSchema = z.enum(['area_rate', 'boq', 'quote', 'manual']);
export const commitmentKindSchema = z.enum(['commitment', 'actual']);
export const schedulePhaseSchema = z.enum([
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
export const calendarBasisSchema = z.enum(['working_days', 'calendar_days']);
export const dependencyTypeSchema = z.enum([
  'finish_to_start',
  'start_to_start',
  'finish_to_finish',
]);
export const accountablePartySchema = z.enum([
  'customer',
  'simplexd',
  'contractor',
  'authority',
  'supplier',
  'consultant',
  'unknown',
]);
export const milestoneStatusSchema = z.enum([
  'pending',
  'in_progress',
  'submitted',
  'accepted',
  'rejected',
]);
export const siteVisitStatusSchema = z.enum([
  'scheduled',
  'in_progress',
  'submitted',
  'reviewed',
  'cancelled',
]);
export const reportKindSchema = z.enum([
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
export const reportStatusSchema = z.enum([
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'released',
  'superseded',
]);
export const evidenceKindSchema = z.enum([
  'photo',
  'video',
  'drone',
  'document',
  'audio',
  'drawing',
  'other',
]);
export const evidencePublicationSchema = z.enum(['restricted', 'approved', 'redacted_public']);
export const defectSeveritySchema = z.enum(['cosmetic', 'minor', 'major', 'critical', 'safety']);
export const defectStatusSchema = z.enum([
  'open',
  'acknowledged',
  'in_progress',
  'resolved',
  'verified',
  'closed',
  'disputed',
]);
export const changeOrderStatusSchema = z.enum([
  'draft',
  'submitted',
  'customer_review',
  'staff_review',
  'approved',
  'rejected',
  'withdrawn',
]);
export const approvalRoleSchema = z.enum([
  'customer',
  'staff',
  'finance',
  'inspector',
  'data_approver',
  'second_approver',
]);
export const approvalStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'withdrawn',
]);
export const permitStatusSchema = z.enum([
  'preparing',
  'submitted',
  'query_raised',
  'resubmitted',
  'approved',
  'rejected',
  'withdrawn',
]);
export const dayBasisSchema = z.enum(['elapsed', 'business']);
export const designOptionStatusSchema = z.enum(['draft', 'signed_off', 'superseded']);

/* ---------------------------------------------------------------------- */
/* Projects                                                                */
/* ---------------------------------------------------------------------- */

export const projectDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  serviceRequestId: uuidSchema.nullable(),
  propertyId: uuidSchema.nullable(),
  marketId: uuidSchema.nullable(),
  name: z.string(),
  kind: projectKindSchema,
  status: projectStatusSchema,
  description: z.string().nullable(),
  approvedBudgetVersionId: uuidSchema.nullable(),
  currentScheduleVersion: z.number().int(),
  startDate: dateOnlySchema.nullable(),
  targetCompletionDate: dateOnlySchema.nullable(),
  forecastCompletionDate: dateOnlySchema.nullable(),
  pmUserId: z.string().nullable(),
  customerContactUserId: z.string().nullable(),
  grossFloorAreaM2: decimalStringSchema.nullable(),
  version: z.number().int(),
  createdBy: z.string().nullable(),
  archivedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type ProjectDto = z.infer<typeof projectDtoSchema>;

export const projectCreateSchema = z.object({
  organizationId: z.string().min(1).max(128),
  name: z.string().trim().min(3).max(160),
  kind: projectKindSchema,
  description: z.string().trim().max(8000).nullable().optional(),
  serviceRequestId: uuidSchema.nullable().optional(),
  propertyId: uuidSchema.nullable().optional(),
  marketId: uuidSchema.nullable().optional(),
  startDate: dateOnlySchema.nullable().optional(),
  targetCompletionDate: dateOnlySchema.nullable().optional(),
  pmUserId: z.string().min(1).max(128).nullable().optional(),
  customerContactUserId: z.string().min(1).max(128).nullable().optional(),
  grossFloorAreaM2: decimalStringSchema.nullable().optional(),
});
export type ProjectCreate = z.infer<typeof projectCreateSchema>;

export const projectUpdateSchema = z
  .object({
    name: z.string().trim().min(3).max(160).optional(),
    description: z.string().trim().max(8000).nullable().optional(),
    startDate: dateOnlySchema.nullable().optional(),
    targetCompletionDate: dateOnlySchema.nullable().optional(),
    pmUserId: z.string().min(1).max(128).nullable().optional(),
    customerContactUserId: z.string().min(1).max(128).nullable().optional(),
    grossFloorAreaM2: decimalStringSchema.nullable().optional(),
    expectedVersion: expectedVersionSchema,
  })
  .refine((v) => Object.keys(v).length > 1, 'nothing to update');
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;

export const projectTransitionSchema = z.object({
  to: projectStatusSchema,
  reason: z.string().trim().max(2000).optional(),
  expectedVersion: expectedVersionSchema,
});
export type ProjectTransition = z.infer<typeof projectTransitionSchema>;

export const projectListQuerySchema = cursorPaginationQuerySchema.extend({
  status: projectStatusSchema.optional(),
  kind: projectKindSchema.optional(),
  /** Staff only: restrict to one customer organisation. */
  organizationId: z.string().max(128).optional(),
  q: z.string().trim().max(80).optional(),
});
export type ProjectListQuery = z.infer<typeof projectListQuerySchema>;

export const budgetVarianceDtoSchema = z.object({
  method: z.literal('commitment_based'),
  hasApprovedBudget: z.boolean(),
  approvedBaseKobo: koboStringSchema.nullable(),
  contingencyKobo: koboStringSchema,
  approvedTotalKobo: koboStringSchema.nullable(),
  committedKobo: koboStringSchema,
  actualKobo: koboStringSchema,
  exposureKobo: koboStringSchema,
  remainingKobo: koboStringSchema.nullable(),
  costToCompleteKobo: koboStringSchema.nullable(),
  forecastFinalCostKobo: koboStringSchema.nullable(),
  varianceKobo: koboStringSchema.nullable(),
  variancePct: z.number().nullable(),
  approvedChangeOrderDeltaKobo: koboStringSchema,
  pendingChangeOrderDeltaKobo: koboStringSchema,
  exposureIfPendingApprovedKobo: koboStringSchema.nullable(),
  progressExtrapolation: z
    .object({
      label: z.literal('scenario_not_a_forecast'),
      percentComplete: z.number().int(),
      finalCostKobo: koboStringSchema,
    })
    .nullable(),
  status: z.enum(['no_approved_budget', 'within_budget', 'over_committed', 'over_spent']),
  notes: z.array(z.string()),
});
export type BudgetVarianceDto = z.infer<typeof budgetVarianceDtoSchema>;

export const teamMemberDtoSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  role: z.string(),
  status: z.string(),
  source: z.enum(['assignment', 'project_manager', 'customer_contact']),
});
export type TeamMemberDto = z.infer<typeof teamMemberDtoSchema>;

export const projectOverviewDtoSchema = z.object({
  project: projectDtoSchema,
  budget: z.object({
    approvedVersionId: uuidSchema.nullable(),
    approvedVersion: z.number().int().nullable(),
    approvedAt: isoDateTimeSchema.nullable(),
    variance: budgetVarianceDtoSchema,
  }),
  schedule: z.object({
    currentScheduleVersion: z.number().int(),
    targetCompletionDate: dateOnlySchema.nullable(),
    forecastCompletionDate: dateOnlySchema.nullable(),
    forecastSource: z.enum(['schedule_baseline', 'change_order_shift', 'unknown']),
    latestBaseline: z
      .object({
        version: z.number().int(),
        computedFinish: dateOnlySchema.nullable(),
        criticalPath: z.array(z.string()),
        createdAt: isoDateTimeSchema,
      })
      .nullable(),
    taskCount: z.number().int(),
    percentComplete: z.number().int().nullable(),
  }),
  milestones: z.object({
    total: z.number().int(),
    byStatus: z.record(milestoneStatusSchema, z.number().int()),
    nextPlannedDate: dateOnlySchema.nullable(),
  }),
  defects: z.object({
    open: z.number().int(),
    bySeverity: z.record(defectSeveritySchema, z.number().int()),
  }),
  changeOrders: z.object({
    pending: z.number().int(),
    approved: z.number().int(),
  }),
  latestReleasedReport: z
    .object({
      id: uuidSchema,
      title: z.string(),
      kind: reportKindSchema,
      releasedVersion: z.number().int(),
      releasedAt: isoDateTimeSchema.nullable(),
    })
    .nullable(),
  pendingApprovals: z.number().int(),
  team: z.array(teamMemberDtoSchema),
  generatedAt: isoDateTimeSchema,
});
export type ProjectOverviewDto = z.infer<typeof projectOverviewDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Budgets, BOQ and commitments                                            */
/* ---------------------------------------------------------------------- */

export const boqItemInputSchema = z.object({
  code: z.string().trim().max(40).nullable().optional(),
  description: z.string().trim().min(1).max(500),
  category: z.string().trim().max(80).nullable().optional(),
  unit: z.string().trim().min(1).max(20),
  /** Up to three decimal places. */
  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/, 'quantity with up to 3 decimal places'),
  rateKobo: nonNegativeKoboStringSchema,
  inclusions: z.string().trim().max(2000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});
export type BoqItemInput = z.infer<typeof boqItemInputSchema>;

export const boqItemDtoSchema = z.object({
  id: uuidSchema,
  budgetVersionId: uuidSchema,
  code: z.string().nullable(),
  description: z.string(),
  category: z.string().nullable(),
  unit: z.string(),
  quantity: decimalStringSchema,
  rateKobo: koboStringSchema,
  /** Computed by the server: quantity × rate rounded to the kobo. */
  amountKobo: koboStringSchema,
  inclusions: z.string().nullable(),
  sortOrder: z.number().int(),
});
export type BoqItemDto = z.infer<typeof boqItemDtoSchema>;

export const approvalDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string().nullable(),
  entityType: z.string(),
  entityId: uuidSchema,
  approverRole: approvalRoleSchema,
  approverUserId: z.string().nullable(),
  status: approvalStatusSchema,
  decisionNote: z.string().nullable(),
  requestedBy: z.string().nullable(),
  requestedAt: isoDateTimeSchema,
  decidedAt: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
});
export type ApprovalDto = z.infer<typeof approvalDtoSchema>;

export const approvalPolicyDtoSchema = z.object({
  requiresCustomerApproval: z.boolean(),
  requiresStaffApproval: z.boolean(),
  outcome: z.enum(['approved', 'rejected', 'pending']),
  missing: z.array(z.enum(['customer', 'staff'])),
});
export type ApprovalPolicyDto = z.infer<typeof approvalPolicyDtoSchema>;

export const budgetVersionDtoSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  version: z.number().int(),
  status: budgetStatusSchema,
  source: budgetSourceSchema,
  totalKobo: koboStringSchema,
  contingencyKobo: koboStringSchema,
  currency: z.string(),
  buildRateKoboPerM2: koboStringSchema.nullable(),
  areaM2: decimalStringSchema.nullable(),
  inclusions: z.string().nullable(),
  notes: z.string().nullable(),
  changeOrderId: uuidSchema.nullable(),
  approvedByCustomerUserId: z.string().nullable(),
  approvedByStaffUserId: z.string().nullable(),
  approvedAt: isoDateTimeSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  items: z.array(boqItemDtoSchema),
  approvals: z.array(approvalDtoSchema),
  approvalPolicy: approvalPolicyDtoSchema,
});
export type BudgetVersionDto = z.infer<typeof budgetVersionDtoSchema>;

const budgetCommonFields = {
  contingencyKobo: nonNegativeKoboStringSchema.optional(),
  inclusions: z.string().trim().max(4000).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
};

export const budgetVersionCreateSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('area_rate'),
    buildRateKoboPerM2: nonNegativeKoboStringSchema,
    /** Defaults to the project's gross floor area; required when the project has none. */
    areaM2: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/, 'area in m² with up to 2 decimal places')
      .optional(),
    ...budgetCommonFields,
  }),
  z.object({
    source: z.literal('boq'),
    items: z.array(boqItemInputSchema).min(1).max(2000),
    ...budgetCommonFields,
  }),
  z.object({
    source: z.literal('quote'),
    /** The accepted quote version whose server-side total becomes the budget. */
    quoteVersionId: uuidSchema,
    ...budgetCommonFields,
  }),
  z.object({
    source: z.literal('manual'),
    totalKobo: nonNegativeKoboStringSchema,
    ...budgetCommonFields,
  }),
]);
export type BudgetVersionCreate = z.infer<typeof budgetVersionCreateSchema>;

export const boqItemsReplaceSchema = z.object({
  items: z.array(boqItemInputSchema).min(1).max(2000),
});
export type BoqItemsReplace = z.infer<typeof boqItemsReplaceSchema>;

export const budgetDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(2000).optional(),
});
export type BudgetDecision = z.infer<typeof budgetDecisionSchema>;

export const commitmentCreateSchema = z.object({
  kind: commitmentKindSchema,
  description: z.string().trim().min(1).max(500),
  amountKobo: nonNegativeKoboStringSchema,
  currency: z.string().length(3).default('NGN'),
  reference: z.string().trim().max(120).nullable().optional(),
  counterparty: z.string().trim().max(200).nullable().optional(),
  incurredAt: dateOnlySchema.nullable().optional(),
  boqItemId: uuidSchema.nullable().optional(),
  evidenceFileId: uuidSchema.nullable().optional(),
});
export type CommitmentCreate = z.infer<typeof commitmentCreateSchema>;

export const commitmentDtoSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  budgetVersionId: uuidSchema.nullable(),
  boqItemId: uuidSchema.nullable(),
  kind: commitmentKindSchema,
  description: z.string(),
  amountKobo: koboStringSchema,
  currency: z.string(),
  reference: z.string().nullable(),
  counterparty: z.string().nullable(),
  incurredAt: dateOnlySchema.nullable(),
  evidenceFileId: uuidSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type CommitmentDto = z.infer<typeof commitmentDtoSchema>;

export const commitmentListQuerySchema = cursorPaginationQuerySchema.extend({
  kind: commitmentKindSchema.optional(),
});

/* ---------------------------------------------------------------------- */
/* Schedule                                                                */
/* ---------------------------------------------------------------------- */

const taskKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'task key: lowercase, digits, _ or -');

export const scheduleTaskInputSchema = z.object({
  key: taskKeySchema,
  name: z.string().trim().min(1).max(200),
  phase: schedulePhaseSchema.default('other'),
  durationDaysMin: z.number().int().min(0).nullable().optional(),
  /** Null means unknown; the engine then reports a missing input instead of inventing a date. */
  durationDaysLikely: z.number().int().min(0).nullable(),
  durationDaysMax: z.number().int().min(0).nullable().optional(),
  calendarBasis: calendarBasisSchema.default('working_days'),
  leadTimeDays: z.number().int().min(0).max(3650).default(0),
  accountableParty: accountablePartySchema.default('unknown'),
  assumptionNotes: z.string().trim().max(2000).nullable().optional(),
  sourceNote: z.string().trim().max(2000).nullable().optional(),
  isMilestone: z.boolean().default(false),
  sortOrder: z.number().int().min(0).optional(),
  actualStart: dateOnlySchema.nullable().optional(),
  actualFinish: dateOnlySchema.nullable().optional(),
  percentComplete: z.number().int().min(0).max(100).default(0),
});
export type ScheduleTaskInput = z.infer<typeof scheduleTaskInputSchema>;

export const scheduleDependencyInputSchema = z.object({
  predecessorKey: taskKeySchema,
  successorKey: taskKeySchema,
  type: dependencyTypeSchema.default('finish_to_start'),
  lagDays: z.number().int().min(-365).max(3650).default(0),
});
export type ScheduleDependencyInput = z.infer<typeof scheduleDependencyInputSchema>;

export const workingCalendarSchema = z.object({
  weekend: z.array(z.number().int().min(1).max(7)).max(6),
  holidays: z.array(dateOnlySchema).max(400),
});

export const scheduleReplaceSchema = z.object({
  tasks: z.array(scheduleTaskInputSchema).min(1).max(500),
  dependencies: z.array(scheduleDependencyInputSchema).max(2000).default([]),
  /** Required when the project has no start date. */
  startDate: dateOnlySchema.optional(),
  workingCalendar: workingCalendarSchema.optional(),
  reason: z.string().trim().max(2000).optional(),
});
export type ScheduleReplace = z.infer<typeof scheduleReplaceSchema>;

export const scheduleTaskActualsSchema = z
  .object({
    actualStart: dateOnlySchema.nullable().optional(),
    actualFinish: dateOnlySchema.nullable().optional(),
    percentComplete: z.number().int().min(0).max(100).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type ScheduleTaskActuals = z.infer<typeof scheduleTaskActualsSchema>;

export const scheduleTaskDtoSchema = z.object({
  id: uuidSchema,
  key: z.string(),
  name: z.string(),
  phase: schedulePhaseSchema,
  durationDaysMin: z.number().int().nullable(),
  durationDaysLikely: z.number().int().nullable(),
  durationDaysMax: z.number().int().nullable(),
  calendarBasis: calendarBasisSchema,
  leadTimeDays: z.number().int(),
  plannedStart: dateOnlySchema.nullable(),
  plannedFinish: dateOnlySchema.nullable(),
  actualStart: dateOnlySchema.nullable(),
  actualFinish: dateOnlySchema.nullable(),
  percentComplete: z.number().int(),
  accountableParty: accountablePartySchema,
  assumptionNotes: z.string().nullable(),
  sourceNote: z.string().nullable(),
  isMilestone: z.boolean(),
  sortOrder: z.number().int(),
  computed: z
    .object({
      earlyStart: dateOnlySchema,
      earlyFinish: dateOnlySchema,
      lateStart: dateOnlySchema,
      lateFinish: dateOnlySchema,
      totalFloatDays: z.number(),
      isCritical: z.boolean(),
      status: z.enum(['planned', 'in_progress', 'complete']),
    })
    .nullable(),
});
export type ScheduleTaskDto = z.infer<typeof scheduleTaskDtoSchema>;

export const scheduleBaselineDtoSchema = z.object({
  id: uuidSchema,
  version: z.number().int(),
  computedFinish: dateOnlySchema.nullable(),
  criticalPath: z.array(z.string()),
  reason: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});

export const scheduleDtoSchema = z.object({
  projectId: uuidSchema,
  scheduleVersion: z.number().int(),
  startDate: dateOnlySchema.nullable(),
  workingCalendar: workingCalendarSchema,
  calendarSource: z.enum(['provided', 'saturday_sunday_convention']),
  canComputeCompletionDate: z.boolean(),
  completionDate: dateOnlySchema.nullable(),
  criticalPath: z.array(z.string()),
  missingInputs: z.array(z.object({ taskKey: z.string(), reason: z.string(), detail: z.string() })),
  range: z
    .object({
      label: z.literal('scenario_range_not_a_promise'),
      minBasedCompletionDate: dateOnlySchema,
      maxBasedCompletionDate: dateOnlySchema,
      expectedBasedCompletionDate: dateOnlySchema,
      tasksWithoutRange: z.array(z.string()),
    })
    .nullable(),
  tasks: z.array(scheduleTaskDtoSchema),
  dependencies: z.array(
    z.object({
      predecessorKey: z.string(),
      successorKey: z.string(),
      type: dependencyTypeSchema,
      lagDays: z.number().int(),
    }),
  ),
  baseline: scheduleBaselineDtoSchema.nullable(),
  baselines: z.array(scheduleBaselineDtoSchema),
});
export type ScheduleDto = z.infer<typeof scheduleDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Milestones                                                              */
/* ---------------------------------------------------------------------- */

export const milestoneDtoSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  plannedDate: dateOnlySchema.nullable(),
  forecastDate: dateOnlySchema.nullable(),
  status: milestoneStatusSchema,
  inspectorProgressPct: z.number().int().nullable(),
  inspectorProgressBy: z.string().nullable(),
  inspectorProgressAt: isoDateTimeSchema.nullable(),
  customerAcceptedBy: z.string().nullable(),
  customerAcceptedAt: isoDateTimeSchema.nullable(),
  customerRejectedReason: z.string().nullable(),
  financeAuthorizedBy: z.string().nullable(),
  financeAuthorizedAt: isoDateTimeSchema.nullable(),
  paymentInvoiceId: uuidSchema.nullable(),
  sortOrder: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type MilestoneDto = z.infer<typeof milestoneDtoSchema>;

export const milestoneCreateSchema = z.object({
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  plannedDate: dateOnlySchema.nullable().optional(),
  forecastDate: dateOnlySchema.nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
});
export type MilestoneCreate = z.infer<typeof milestoneCreateSchema>;

export const milestoneUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    plannedDate: dateOnlySchema.nullable().optional(),
    forecastDate: dateOnlySchema.nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
    /** Concurrency token: the updatedAt the client loaded. */
    expectedUpdatedAt: isoDateTimeSchema.optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'expectedUpdatedAt'), 'nothing to update');
export type MilestoneUpdate = z.infer<typeof milestoneUpdateSchema>;

export const milestoneProgressSchema = z.object({
  percentComplete: z.number().int().min(0).max(100),
  note: z.string().trim().max(2000).optional(),
});
export type MilestoneProgress = z.infer<typeof milestoneProgressSchema>;

export const milestoneAcceptanceSchema = z
  .object({
    decision: z.enum(['accepted', 'rejected']),
    reason: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.decision === 'accepted' || Boolean(v.reason?.trim()), {
    message: 'a reason is required to reject a milestone',
    path: ['reason'],
  });
export type MilestoneAcceptance = z.infer<typeof milestoneAcceptanceSchema>;

export const milestoneFinanceAuthorizationSchema = z.object({
  paymentInvoiceId: uuidSchema.nullable().optional(),
  note: z.string().trim().max(2000).optional(),
});
export type MilestoneFinanceAuthorization = z.infer<typeof milestoneFinanceAuthorizationSchema>;

/* ---------------------------------------------------------------------- */
/* Site visits                                                             */
/* ---------------------------------------------------------------------- */

export const siteVisitDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  projectId: uuidSchema.nullable(),
  propertyId: uuidSchema.nullable(),
  serviceRequestId: uuidSchema.nullable(),
  appointmentId: uuidSchema.nullable(),
  scheduledAt: isoDateTimeSchema.nullable(),
  inspectorUserId: z.string().nullable(),
  inspectorName: z.string().nullable(),
  status: siteVisitStatusSchema,
  instructions: z.string().nullable(),
  checklist: z.unknown().nullable(),
  findingsMarkdown: z.string().nullable(),
  weather: z.string().nullable(),
  accessNote: z.string().nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  submittedAt: isoDateTimeSchema.nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: isoDateTimeSchema.nullable(),
  offlineClientId: z.string().nullable(),
  evidenceCount: z.number().int(),
  /** Started by the inspector in the field without a scheduled visit (no `scheduledAt`). */
  unscheduled: z.boolean(),
  /** The inspector's stated reason for an unscheduled visit. */
  unscheduledReason: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type SiteVisitDto = z.infer<typeof siteVisitDtoSchema>;

/** Mutation responses carry `idempotentReplay` when an offline id was replayed. */
export const siteVisitMutationResponseSchema = siteVisitDtoSchema.extend({
  idempotentReplay: z.boolean(),
});

export const siteVisitScheduleSchema = z.object({
  inspectorUserId: z.string().min(1).max(128),
  scheduledAt: isoDateTimeSchema,
  instructions: z.string().trim().max(8000).nullable().optional(),
  checklist: jsonValueSchema.optional(),
  propertyId: uuidSchema.nullable().optional(),
  serviceRequestId: uuidSchema.nullable().optional(),
  offlineClientId: offlineClientIdSchema.optional(),
});
export type SiteVisitSchedule = z.infer<typeof siteVisitScheduleSchema>;

export const siteVisitStartSchema = z.object({
  /** Field capture time as recorded on the device; the server keeps updatedAt separately. */
  startedAt: isoDateTimeSchema.optional(),
  offlineClientId: offlineClientIdSchema.optional(),
});
export type SiteVisitStart = z.infer<typeof siteVisitStartSchema>;

export const siteVisitSubmitSchema = z.object({
  findingsMarkdown: z.string().trim().min(1).max(100_000),
  checklist: jsonValueSchema.optional(),
  weather: z.string().trim().max(200).nullable().optional(),
  accessNote: z.string().trim().max(2000).nullable().optional(),
  submittedAt: isoDateTimeSchema.optional(),
  offlineClientId: offlineClientIdSchema.optional(),
  /** Already uploaded, scanned files to link as evidence of this visit. */
  evidenceFileIds: z.array(uuidSchema).max(200).default([]),
});
export type SiteVisitSubmit = z.infer<typeof siteVisitSubmitSchema>;

export const siteVisitReviewSchema = z.object({ note: z.string().trim().max(2000).optional() });
export const siteVisitCancelSchema = z.object({ reason: z.string().trim().min(3).max(2000) });

export const siteVisitListQuerySchema = cursorPaginationQuerySchema.extend({
  status: siteVisitStatusSchema.optional(),
});

export const siteVisitSyncItemSchema = z.object({
  offlineClientId: offlineClientIdSchema,
  /** Existing visit to submit; omit to create a visit the inspector scheduled in the field. */
  siteVisitId: uuidSchema.optional(),
  projectId: uuidSchema.optional(),
  scheduledAt: isoDateTimeSchema.optional(),
  /** Required when an assigned partner creates the visit from the field; flags it unscheduled. */
  unscheduledReason: z.string().trim().min(5).max(2000).optional(),
  startedAt: isoDateTimeSchema.optional(),
  submittedAt: isoDateTimeSchema.optional(),
  findingsMarkdown: z.string().trim().min(1).max(100_000),
  checklist: jsonValueSchema.optional(),
  weather: z.string().trim().max(200).nullable().optional(),
  accessNote: z.string().trim().max(2000).nullable().optional(),
  evidenceFileIds: z.array(uuidSchema).max(200).default([]),
});
export type SiteVisitSyncItem = z.infer<typeof siteVisitSyncItemSchema>;

export const siteVisitSyncSchema = z.object({
  items: z.array(siteVisitSyncItemSchema).min(1).max(50),
});
export type SiteVisitSync = z.infer<typeof siteVisitSyncSchema>;

export const siteVisitSyncResultSchema = z.object({
  offlineClientId: z.string(),
  outcome: z.enum(['created', 'replayed', 'rejected']),
  siteVisitId: uuidSchema.nullable(),
  code: z.string().nullable(),
  reason: z.string().nullable(),
  evidence: z.array(
    z.object({
      fileId: uuidSchema,
      outcome: z.enum(['created', 'replayed', 'rejected']),
      evidenceId: uuidSchema.nullable(),
      reason: z.string().nullable(),
    }),
  ),
});
export type SiteVisitSyncResult = z.infer<typeof siteVisitSyncResultSchema>;

export const siteVisitSyncResponseSchema = z.object({
  results: z.array(siteVisitSyncResultSchema),
});

/* ---------------------------------------------------------------------- */
/* Reports and revisions                                                   */
/* ---------------------------------------------------------------------- */

export const reportRevisionInputSchema = z.object({
  summary: z.string().trim().max(2000).nullable().optional(),
  bodyMarkdown: z.string().trim().min(1).max(500_000),
  findings: jsonValueSchema.optional(),
  attachmentFileIds: z.array(uuidSchema).max(200).default([]),
  scopeLimitations: z.string().trim().max(8000).nullable().optional(),
});
export type ReportRevisionInput = z.infer<typeof reportRevisionInputSchema>;

export const reportCreateSchema = z.object({
  kind: reportKindSchema,
  title: z.string().trim().min(3).max(200),
  siteVisitId: uuidSchema.nullable().optional(),
  serviceRequestId: uuidSchema.nullable().optional(),
  offlineClientId: offlineClientIdSchema.optional(),
  initialRevision: reportRevisionInputSchema.optional(),
});
export type ReportCreate = z.infer<typeof reportCreateSchema>;

export const reportRevisionCreateSchema = reportRevisionInputSchema.extend({
  expectedVersion: expectedVersionSchema,
});
export type ReportRevisionCreate = z.infer<typeof reportRevisionCreateSchema>;

export const reportSubmitSchema = z.object({
  namedReviewerUserId: z.string().min(1).max(128),
  expectedVersion: expectedVersionSchema,
});
export type ReportSubmit = z.infer<typeof reportSubmitSchema>;

export const reportReviewSchema = z
  .object({
    decision: z.enum(['approved', 'changes_requested']),
    note: z.string().trim().max(4000).optional(),
    expectedVersion: expectedVersionSchema,
  })
  .refine((v) => v.decision === 'approved' || Boolean(v.note?.trim()), {
    message: 'a note is required when requesting changes',
    path: ['note'],
  });
export type ReportReview = z.infer<typeof reportReviewSchema>;

export const reportReleaseSchema = z.object({
  expectedVersion: expectedVersionSchema,
  note: z.string().trim().max(2000).optional(),
});
export type ReportRelease = z.infer<typeof reportReleaseSchema>;

export const reportRevisionDtoSchema = z.object({
  id: uuidSchema,
  reportId: uuidSchema,
  version: z.number().int(),
  summary: z.string().nullable(),
  bodyMarkdown: z.string(),
  findings: z.unknown().nullable(),
  attachmentFileIds: z.array(uuidSchema),
  scopeLimitations: z.string().nullable(),
  reviewerUserId: z.string().nullable(),
  reviewDecision: z.string().nullable(),
  reviewNote: z.string().nullable(),
  reviewedAt: isoDateTimeSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  state: reportStatusSchema,
});
export type ReportRevisionDto = z.infer<typeof reportRevisionDtoSchema>;

export const reportDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  projectId: uuidSchema.nullable(),
  serviceRequestId: uuidSchema.nullable(),
  siteVisitId: uuidSchema.nullable(),
  kind: reportKindSchema,
  title: z.string(),
  status: reportStatusSchema,
  currentVersion: z.number().int(),
  releasedVersion: z.number().int().nullable(),
  releasedAt: isoDateTimeSchema.nullable(),
  releasedBy: z.string().nullable(),
  customerVisible: z.boolean(),
  namedReviewerUserId: z.string().nullable(),
  namedReviewerName: z.string().nullable(),
  createdBy: z.string().nullable(),
  authorName: z.string().nullable(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type ReportDto = z.infer<typeof reportDtoSchema>;

export const reportDetailDtoSchema = reportDtoSchema.extend({
  revisions: z.array(reportRevisionDtoSchema),
  availableTransitions: z.array(z.object({ to: reportStatusSchema, reasonRequired: z.boolean() })),
});
export type ReportDetailDto = z.infer<typeof reportDetailDtoSchema>;

export const reportListQuerySchema = cursorPaginationQuerySchema.extend({
  status: reportStatusSchema.optional(),
  kind: reportKindSchema.optional(),
});

/* ---------------------------------------------------------------------- */
/* Evidence                                                                */
/* ---------------------------------------------------------------------- */

export const evidenceDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  projectId: uuidSchema.nullable(),
  serviceRequestId: uuidSchema.nullable(),
  siteVisitId: uuidSchema.nullable(),
  reportId: uuidSchema.nullable(),
  defectId: uuidSchema.nullable(),
  fileId: uuidSchema,
  kind: evidenceKindSchema,
  caption: z.string().nullable(),
  /** User-provided capture time; not proof of authenticity. */
  capturedAt: isoDateTimeSchema.nullable(),
  captureGps: captureGpsSchema.nullable(),
  captureMetadata: z.unknown().nullable(),
  uploaderUserId: z.string(),
  /** Server receipt time; never set by the client. */
  receivedAt: isoDateTimeSchema,
  checksumSha256: z.string(),
  publication: evidencePublicationSchema,
  redactedFileId: uuidSchema.nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: isoDateTimeSchema.nullable(),
  offlineClientId: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  file: z
    .object({
      originalName: z.string(),
      declaredMime: z.string(),
      sizeBytes: z.number().nullable(),
      status: z.string(),
    })
    .nullable(),
});
export type EvidenceDto = z.infer<typeof evidenceDtoSchema>;

export const evidenceMutationResponseSchema = evidenceDtoSchema.extend({
  idempotentReplay: z.boolean(),
});

export const evidenceLinkSchema = z.object({
  fileId: uuidSchema,
  kind: evidenceKindSchema.optional(),
  caption: z.string().trim().max(1000).nullable().optional(),
  capturedAt: isoDateTimeSchema.nullable().optional(),
  captureGps: captureGpsSchema.nullable().optional(),
  captureMetadata: jsonObjectSchema.nullable().optional(),
  siteVisitId: uuidSchema.nullable().optional(),
  reportId: uuidSchema.nullable().optional(),
  defectId: uuidSchema.nullable().optional(),
  offlineClientId: offlineClientIdSchema.optional(),
});
export type EvidenceLink = z.infer<typeof evidenceLinkSchema>;

export const evidencePublicationUpdateSchema = z
  .object({
    publication: evidencePublicationSchema,
    /** Required for redacted_public: the derivative that hides sensitive detail. */
    redactedFileId: uuidSchema.nullable().optional(),
  })
  .refine((v) => v.publication !== 'redacted_public' || Boolean(v.redactedFileId), {
    message: 'redacted_public requires a redactedFileId',
    path: ['redactedFileId'],
  });
export type EvidencePublicationUpdate = z.infer<typeof evidencePublicationUpdateSchema>;

export const evidenceListQuerySchema = cursorPaginationQuerySchema.extend({
  siteVisitId: uuidSchema.optional(),
  reportId: uuidSchema.optional(),
  defectId: uuidSchema.optional(),
  kind: evidenceKindSchema.optional(),
  publication: evidencePublicationSchema.optional(),
});
export type EvidenceListQuery = z.infer<typeof evidenceListQuerySchema>;

/* ---------------------------------------------------------------------- */
/* Defects                                                                 */
/* ---------------------------------------------------------------------- */

export const defectDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  projectId: uuidSchema.nullable(),
  propertyId: uuidSchema.nullable(),
  siteVisitId: uuidSchema.nullable(),
  reportId: uuidSchema.nullable(),
  number: z.number().int().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  severity: defectSeveritySchema,
  status: defectStatusSchema,
  accountableParty: accountablePartySchema,
  locationNote: z.string().nullable(),
  dueDate: dateOnlySchema.nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
  verifiedBy: z.string().nullable(),
  verifiedAt: isoDateTimeSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type DefectDto = z.infer<typeof defectDtoSchema>;

export const defectCreateSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(8000).nullable().optional(),
  severity: defectSeveritySchema.default('minor'),
  accountableParty: accountablePartySchema.default('unknown'),
  locationNote: z.string().trim().max(500).nullable().optional(),
  dueDate: dateOnlySchema.nullable().optional(),
  siteVisitId: uuidSchema.nullable().optional(),
  reportId: uuidSchema.nullable().optional(),
  propertyId: uuidSchema.nullable().optional(),
});
export type DefectCreate = z.infer<typeof defectCreateSchema>;

export const defectUpdateSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(8000).nullable().optional(),
    severity: defectSeveritySchema.optional(),
    accountableParty: accountablePartySchema.optional(),
    locationNote: z.string().trim().max(500).nullable().optional(),
    dueDate: dateOnlySchema.nullable().optional(),
    expectedUpdatedAt: isoDateTimeSchema.optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'expectedUpdatedAt'), 'nothing to update');
export type DefectUpdate = z.infer<typeof defectUpdateSchema>;

export const defectTransitionSchema = z.object({
  to: defectStatusSchema,
  reason: z.string().trim().max(2000).optional(),
});
export type DefectTransition = z.infer<typeof defectTransitionSchema>;

export const defectListQuerySchema = cursorPaginationQuerySchema.extend({
  status: defectStatusSchema.optional(),
  severity: defectSeveritySchema.optional(),
  unresolvedOnly: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});
export type DefectListQuery = z.infer<typeof defectListQuerySchema>;

export const unresolvedIssuesDtoSchema = z.object({
  projectId: uuidSchema,
  defects: z.array(defectDtoSchema),
  counts: z.record(defectStatusSchema, z.number().int()),
  pendingChangeOrders: z.number().int(),
  pendingApprovals: z.number().int(),
  rejectedMilestones: z.number().int(),
  generatedAt: isoDateTimeSchema,
});
export type UnresolvedIssuesDto = z.infer<typeof unresolvedIssuesDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Change orders and approvals                                             */
/* ---------------------------------------------------------------------- */

export const changeOrderDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  projectId: uuidSchema,
  baseBudgetVersionId: uuidSchema.nullable(),
  number: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  amountDeltaKobo: koboStringSchema,
  scheduleDeltaDays: z.number().int(),
  status: changeOrderStatusSchema,
  requiresCustomerApproval: z.boolean(),
  requiresStaffApproval: z.boolean(),
  appliedBudgetVersionId: uuidSchema.nullable(),
  submittedAt: isoDateTimeSchema.nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  decisionNote: z.string().nullable(),
  createdBy: z.string().nullable(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  approvals: z.array(approvalDtoSchema),
  approvalPolicy: approvalPolicyDtoSchema,
});
export type ChangeOrderDto = z.infer<typeof changeOrderDtoSchema>;

export const changeOrderCreateSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(8000).nullable().optional(),
  amountDeltaKobo: koboStringSchema,
  scheduleDeltaDays: z.number().int().min(-3650).max(3650).default(0),
  requiresCustomerApproval: z.boolean().default(true),
  requiresStaffApproval: z.boolean().default(true),
});
export type ChangeOrderCreate = z.infer<typeof changeOrderCreateSchema>;

export const changeOrderUpdateSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(8000).nullable().optional(),
    amountDeltaKobo: koboStringSchema.optional(),
    scheduleDeltaDays: z.number().int().min(-3650).max(3650).optional(),
    requiresCustomerApproval: z.boolean().optional(),
    requiresStaffApproval: z.boolean().optional(),
    expectedVersion: expectedVersionSchema,
  })
  .refine((v) => Object.keys(v).length > 1, 'nothing to update');
export type ChangeOrderUpdate = z.infer<typeof changeOrderUpdateSchema>;

export const changeOrderSubmitSchema = z.object({ expectedVersion: expectedVersionSchema });

export const changeOrderDecisionSchema = z
  .object({
    approverRole: z.enum(['customer', 'staff']),
    decision: z.enum(['approved', 'rejected']),
    note: z.string().trim().max(4000).optional(),
    expectedVersion: expectedVersionSchema,
  })
  .refine((v) => v.decision === 'approved' || Boolean(v.note?.trim()), {
    message: 'a note is required to reject a change order',
    path: ['note'],
  });
export type ChangeOrderDecision = z.infer<typeof changeOrderDecisionSchema>;

export const changeOrderWithdrawSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
  expectedVersion: expectedVersionSchema,
});
export type ChangeOrderWithdraw = z.infer<typeof changeOrderWithdrawSchema>;

export const changeOrderListQuerySchema = cursorPaginationQuerySchema.extend({
  status: changeOrderStatusSchema.optional(),
});

export const approvalEntityTypeSchema = z.enum(['change_order', 'budget_version', 'milestone']);

export const approvalsQuerySchema = z.object({
  entityType: approvalEntityTypeSchema,
  entityId: uuidSchema,
});
export type ApprovalsQuery = z.infer<typeof approvalsQuerySchema>;

export const pendingApprovalDtoSchema = approvalDtoSchema.extend({
  projectId: uuidSchema.nullable(),
  projectName: z.string().nullable(),
  entityTitle: z.string().nullable(),
});
export type PendingApprovalDto = z.infer<typeof pendingApprovalDtoSchema>;

export const pendingApprovalsResponseSchema = z.object({
  items: z.array(pendingApprovalDtoSchema),
  /** Which approver role the caller can act as; empty when they cannot decide anything. */
  actingAs: z.array(z.enum(['customer', 'staff'])),
});
export type PendingApprovalsResponse = z.infer<typeof pendingApprovalsResponseSchema>;

/* ---------------------------------------------------------------------- */
/* Design options and comments                                             */
/* ---------------------------------------------------------------------- */

export const designCommentDtoSchema = z.object({
  id: uuidSchema,
  designOptionId: uuidSchema,
  authorUserId: z.string(),
  authorName: z.string().nullable(),
  body: z.string(),
  anchor: z.unknown().nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type DesignCommentDto = z.infer<typeof designCommentDtoSchema>;

export const designOptionDtoSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  title: z.string(),
  description: z.string().nullable(),
  drawingFileIds: z.array(uuidSchema),
  version: z.number().int(),
  status: designOptionStatusSchema,
  isCurrentVersion: z.boolean(),
  customerSignoffBy: z.string().nullable(),
  customerSignoffAt: isoDateTimeSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  comments: z.array(designCommentDtoSchema),
});
export type DesignOptionDto = z.infer<typeof designOptionDtoSchema>;

export const designOptionCreateSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(8000).nullable().optional(),
  drawingFileIds: z.array(uuidSchema).max(100).default([]),
});
export type DesignOptionCreate = z.infer<typeof designOptionCreateSchema>;

export const designOptionUpdateSchema = z
  .object({
    description: z.string().trim().max(8000).nullable().optional(),
    drawingFileIds: z.array(uuidSchema).max(100).optional(),
    expectedUpdatedAt: isoDateTimeSchema.optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'expectedUpdatedAt'), 'nothing to update');
export type DesignOptionUpdate = z.infer<typeof designOptionUpdateSchema>;

export const designCommentCreateSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  /** Drawing anchor (file id, page, coordinates) as opaque JSON. */
  anchor: jsonObjectSchema.nullable().optional(),
});
export type DesignCommentCreate = z.infer<typeof designCommentCreateSchema>;

export const designSignOffSchema = z.object({
  /** Explicit confirmation that the customer signs off this version of the deliverable. */
  confirm: z.literal(true),
  note: z.string().trim().max(2000).optional(),
});
export type DesignSignOff = z.infer<typeof designSignOffSchema>;

export const designOptionNewVersionSchema = z.object({
  description: z.string().trim().max(8000).nullable().optional(),
  drawingFileIds: z.array(uuidSchema).max(100).default([]),
  reason: z.string().trim().max(2000).optional(),
});
export type DesignOptionNewVersion = z.infer<typeof designOptionNewVersionSchema>;

/* ---------------------------------------------------------------------- */
/* Permit applications                                                     */
/* ---------------------------------------------------------------------- */

export const permitEventTypeSchema = z.enum([
  'submitted',
  'query_raised',
  'resubmitted',
  'approved',
  'rejected',
  'withdrawn',
  'fee_paid',
  'completeness_confirmed',
  'note',
]);

export const permitEventDtoSchema = z.object({
  id: uuidSchema,
  permitApplicationId: uuidSchema,
  eventType: z.string(),
  occurredAt: dateOnlySchema,
  note: z.string().nullable(),
  actorUserId: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type PermitEventDto = z.infer<typeof permitEventDtoSchema>;

export const statutoryTargetSchema = z.object({
  days: z.number().int().min(1).max(3650),
  basis: dayBasisSchema,
  /** Where the statutory figure comes from (regulation, circular, official page). Required. */
  sourceNote: z.string().trim().min(3).max(2000),
});

export const permitDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  projectId: uuidSchema.nullable(),
  propertyId: uuidSchema.nullable(),
  jurisdiction: z.string(),
  authority: z.string(),
  permitType: z.string(),
  documentType: z.string().nullable(),
  status: permitStatusSchema,
  completenessDate: dateOnlySchema.nullable(),
  applicationReference: z.string().nullable(),
  feesKobo: koboStringSchema.nullable(),
  submittedAt: dateOnlySchema.nullable(),
  decidedAt: dateOnlySchema.nullable(),
  statutoryTarget: statutoryTargetSchema.nullable(),
  /** "unknown" whenever no sourced statutory target was recorded; never a default. */
  statutoryTargetStatus: z.enum(['known', 'unknown']),
  notes: z.string().nullable(),
  elapsed: z
    .object({
      basis: dayBasisSchema,
      asOf: z.string(),
      applicantDays: z.number(),
      authorityDays: z.number(),
      totalDays: z.number(),
      status: z.enum(['not_submitted', 'with_authority', 'with_applicant', 'decided']),
    })
    .nullable(),
  events: z.array(permitEventDtoSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type PermitDto = z.infer<typeof permitDtoSchema>;

export const permitCreateSchema = z.object({
  jurisdiction: z.string().trim().min(2).max(120),
  authority: z.string().trim().min(2).max(200),
  permitType: z.string().trim().min(2).max(120),
  documentType: z.string().trim().max(120).nullable().optional(),
  propertyId: uuidSchema.nullable().optional(),
  completenessDate: dateOnlySchema.nullable().optional(),
  applicationReference: z.string().trim().max(120).nullable().optional(),
  feesKobo: nonNegativeKoboStringSchema.nullable().optional(),
  statutoryTarget: statutoryTargetSchema.nullable().optional(),
  notes: z.string().trim().max(8000).nullable().optional(),
});
export type PermitCreate = z.infer<typeof permitCreateSchema>;

export const permitUpdateSchema = z
  .object({
    documentType: z.string().trim().max(120).nullable().optional(),
    completenessDate: dateOnlySchema.nullable().optional(),
    applicationReference: z.string().trim().max(120).nullable().optional(),
    feesKobo: nonNegativeKoboStringSchema.nullable().optional(),
    statutoryTarget: statutoryTargetSchema.nullable().optional(),
    notes: z.string().trim().max(8000).nullable().optional(),
    expectedUpdatedAt: isoDateTimeSchema.optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'expectedUpdatedAt'), 'nothing to update');
export type PermitUpdate = z.infer<typeof permitUpdateSchema>;

export const permitEventCreateSchema = z.object({
  eventType: permitEventTypeSchema,
  occurredAt: dateOnlySchema,
  note: z.string().trim().max(4000).nullable().optional(),
});
export type PermitEventCreate = z.infer<typeof permitEventCreateSchema>;
