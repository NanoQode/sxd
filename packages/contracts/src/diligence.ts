import { z } from 'zod';
import { visibilitySchema } from './collaboration';
import {
  cursorPaginationQuerySchema,
  expectedVersionSchema,
  isoDateTimeSchema,
  uuidSchema,
} from './common';
import { fileStatusSchema } from './files';
import { reportDtoSchema, reportRevisionInputSchema } from './projects';

/**
 * Engagement records on a service request (brief §8 due diligence, virtual
 * inspections, purchase representation): checklist items, survey
 * references, site findings, queries, red flags, conditions, closing tasks,
 * handover documents and lease milestones; plus reports drafted directly
 * under a service request and the engagement workspace read model.
 */

export const engagementItemKindSchema = z.enum([
  'document_check',
  'survey_reference',
  'site_finding',
  'query',
  'red_flag',
  'condition',
  'closing_task',
  'handover_document',
  'lease_milestone',
]);
export type EngagementItemKindDto = z.infer<typeof engagementItemKindSchema>;

export const engagementItemStatusSchema = z.enum([
  'open',
  'in_progress',
  'satisfied',
  'waived',
  'failed',
  'cancelled',
]);
export type EngagementItemStatusDto = z.infer<typeof engagementItemStatusSchema>;

export const engagementItemSeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type EngagementItemSeverityDto = z.infer<typeof engagementItemSeveritySchema>;

const titleSchema = z.string().trim().min(1).max(300);
const detailSchema = z.string().trim().max(8000);
const referenceSchema = z.string().trim().max(300);

export const engagementItemCreateSchema = z.object({
  kind: engagementItemKindSchema,
  title: titleSchema,
  detail: detailSchema.nullable().optional(),
  /** External reference: survey plan number, registry entry, instrument number. */
  reference: referenceSchema.nullable().optional(),
  /** Required for red flags and site findings. */
  severity: engagementItemSeveritySchema.nullable().optional(),
  /** Defaults per kind (usually `customer`). `internal` items stay with staff. */
  visibility: visibilitySchema.optional(),
  /** A staff member, or a partner with an accepted/active assignment on the request. */
  assigneeUserId: z.string().min(1).max(128).nullable().optional(),
  dueAt: isoDateTimeSchema.nullable().optional(),
  /** Optional link to the record the item concerns (offer, listing, site visit...). */
  subjectType: z.string().trim().min(1).max(64).nullable().optional(),
  subjectId: uuidSchema.nullable().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});
export type EngagementItemCreate = z.infer<typeof engagementItemCreateSchema>;

/**
 * Partial update. Staff who manage the request may change every field;
 * the assignee may change `detail`, `reference` and `severity` only.
 */
export const engagementItemUpdateSchema = z.object({
  title: titleSchema.optional(),
  detail: detailSchema.nullable().optional(),
  reference: referenceSchema.nullable().optional(),
  severity: engagementItemSeveritySchema.nullable().optional(),
  visibility: visibilitySchema.optional(),
  assigneeUserId: z.string().min(1).max(128).nullable().optional(),
  dueAt: isoDateTimeSchema.nullable().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  expectedVersion: expectedVersionSchema,
});
export type EngagementItemUpdate = z.infer<typeof engagementItemUpdateSchema>;

export const engagementItemTransitionSchema = z.object({
  to: engagementItemStatusSchema,
  /** Required for failed, waived, cancelled and for reopening a closed item. */
  reason: z.string().trim().max(2000).optional(),
  /** Stored as the resolution note when the item closes (defaults to the reason). */
  resolutionNote: z.string().trim().max(4000).optional(),
  expectedVersion: expectedVersionSchema,
});
export type EngagementItemTransition = z.infer<typeof engagementItemTransitionSchema>;

export const engagementItemEvidenceSchema = z.object({
  /** Files the caller uploaded (or, for staff and customers, files already on the request). */
  fileIds: z.array(uuidSchema).min(1).max(20),
  caption: z.string().trim().max(500).optional(),
  /** User-provided capture time; recorded separately from server receipt, not proof. */
  capturedAt: isoDateTimeSchema.optional(),
  expectedVersion: expectedVersionSchema,
});
export type EngagementItemEvidence = z.infer<typeof engagementItemEvidenceSchema>;

export const engagementItemResponseCreateSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  expectedVersion: expectedVersionSchema,
});
export type EngagementItemResponseCreate = z.infer<typeof engagementItemResponseCreateSchema>;

export const engagementItemListQuerySchema = cursorPaginationQuerySchema.extend({
  kind: engagementItemKindSchema.optional(),
  status: engagementItemStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(200),
});
export type EngagementItemListQuery = z.infer<typeof engagementItemListQuerySchema>;

export const myEngagementItemsQuerySchema = cursorPaginationQuerySchema.extend({
  kind: engagementItemKindSchema.optional(),
  status: engagementItemStatusSchema.optional(),
  serviceRequestId: uuidSchema.optional(),
  /** Open (open + in progress) items only unless false. */
  openOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v !== 'false'),
});
export type MyEngagementItemsQuery = z.infer<typeof myEngagementItemsQuerySchema>;

export const engagementItemFileDtoSchema = z.object({
  fileId: uuidSchema,
  originalName: z.string(),
  status: fileStatusSchema,
  sizeBytes: z.number().int().nullable(),
  checksumSha256: z.string().nullable(),
  uploadedByUserId: z.string().nullable(),
  uploadedByName: z.string().nullable(),
  receivedAt: isoDateTimeSchema,
});
export type EngagementItemFileDto = z.infer<typeof engagementItemFileDtoSchema>;

export const engagementItemResponseDtoSchema = z.object({
  id: uuidSchema,
  body: z.string(),
  authorUserId: z.string(),
  authorName: z.string().nullable(),
  authorRole: z.enum(['customer', 'staff', 'partner']),
  createdAt: isoDateTimeSchema,
});
export type EngagementItemResponseDto = z.infer<typeof engagementItemResponseDtoSchema>;

export const engagementItemCapabilitiesSchema = z.object({
  /** Fields the caller may change with PATCH (empty when none). */
  editableFields: z.array(z.string()),
  transitions: z.array(z.object({ to: engagementItemStatusSchema, reasonRequired: z.boolean() })),
  attachEvidence: z.boolean(),
  respond: z.boolean(),
});

export const engagementItemDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  serviceRequestId: uuidSchema,
  serviceRequestReference: z.string().nullable(),
  serviceRequestTitle: z.string().nullable(),
  kind: engagementItemKindSchema,
  kindLabel: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  reference: z.string().nullable(),
  status: engagementItemStatusSchema,
  severity: engagementItemSeveritySchema.nullable(),
  visibility: visibilitySchema,
  assigneeUserId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  dueAt: isoDateTimeSchema.nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
  resolvedByName: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  subjectType: z.string().nullable(),
  subjectId: uuidSchema.nullable(),
  sortOrder: z.number().int(),
  /** Evidence the caller may open (files outside the caller's access are left out). */
  evidence: z.array(engagementItemFileDtoSchema),
  responses: z.array(engagementItemResponseDtoSchema),
  can: engagementItemCapabilitiesSchema,
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type EngagementItemDto = z.infer<typeof engagementItemDtoSchema>;

export const engagementItemSummaryDtoSchema = z.object({
  total: z.number().int(),
  open: z.number().int(),
  resolved: z.number().int(),
  redFlags: z.object({
    open: z.number().int(),
    total: z.number().int(),
    highestOpenSeverity: engagementItemSeveritySchema.nullable(),
  }),
  openCustomerQueries: z.number().int(),
  openDocumentRequests: z.number().int(),
});

/* ---------------------------------------------------------------------- */
/* Reports under a service request                                         */
/* ---------------------------------------------------------------------- */

export const serviceRequestReportKindSchema = z.enum([
  'diligence_memo',
  'virtual_inspection',
  'closing_pack',
  'search_outcome',
]);
export type ServiceRequestReportKind = z.infer<typeof serviceRequestReportKindSchema>;

export const serviceRequestReportCreateSchema = z.object({
  kind: serviceRequestReportKindSchema,
  title: z.string().trim().min(3).max(200),
  /** An active report template of the same kind; otherwise the newest active one is used. */
  templateId: uuidSchema.optional(),
  /**
   * Snapshot the customer-visible engagement items (red flags, findings,
   * checklist status and their evidence references) into every revision.
   */
  referenceItems: z.boolean().default(true),
  /** Author's own first revision; when absent the body is the template's section outline. */
  initialRevision: reportRevisionInputSchema.optional(),
});
export type ServiceRequestReportCreate = z.infer<typeof serviceRequestReportCreateSchema>;

export const reportTemplateSectionDtoSchema = z.object({
  key: z.string(),
  heading: z.string(),
  guidance: z.string().nullable(),
  required: z.boolean(),
});

export const reportTemplateOutlineDtoSchema = z.object({
  /** Null when the built-in outline was used because no active template exists. */
  id: uuidSchema.nullable(),
  name: z.string(),
  version: z.number().int().nullable(),
  sections: z.array(reportTemplateSectionDtoSchema),
  limitationsMarkdown: z.string().nullable(),
});
export type ReportTemplateOutlineDto = z.infer<typeof reportTemplateOutlineDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Workspace read model                                                    */
/* ---------------------------------------------------------------------- */

export const workspaceAppointmentDtoSchema = z.object({
  id: uuidSchema,
  kind: z.string(),
  status: z.string(),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  meetingProvider: z.string(),
  conferenceStatus: z.string(),
  /** Only while the meeting is ready and the appointment active, and only for its participants. */
  meetingUrl: z.string().nullable(),
  staffName: z.string().nullable(),
});
export type WorkspaceAppointmentDto = z.infer<typeof workspaceAppointmentDtoSchema>;

export const engagementWorkspaceDtoSchema = z.object({
  serviceRequestId: uuidSchema,
  reference: z.string(),
  title: z.string(),
  status: z.string(),
  serviceName: z.string(),
  workflowTemplateKey: z.string(),
  viewer: z.enum(['staff', 'customer', 'partner']),
  items: z.array(engagementItemDtoSchema),
  summary: engagementItemSummaryDtoSchema,
  /** Customers: released reports only. Partners: none. */
  reports: z.array(reportDtoSchema),
  appointments: z.array(workspaceAppointmentDtoSchema),
  canManageItems: z.boolean(),
  canDraftReports: z.boolean(),
});
export type EngagementWorkspaceDto = z.infer<typeof engagementWorkspaceDtoSchema>;
