import { z } from 'zod';
import { cursorPaginationQuerySchema, isoDateTimeSchema, uuidSchema } from './common';

/**
 * Collaboration contracts: assignments of staff and partners to service
 * requests and projects, tasks with explicit visibility, append-only notes on
 * any operational entity, and conversations with messages. Every note, task
 * and message carries an explicit visibility so internal staff commentary can
 * never leak to a customer or partner.
 */

export const visibilitySchema = z.enum(['internal', 'customer', 'partner', 'all']);
export type Visibility = z.infer<typeof visibilitySchema>;

export const userIdSchema = z.string().min(1).max(64);

/* ---------------------------------------------------------------------- */
/* Assignments                                                             */
/* ---------------------------------------------------------------------- */

export const assignmentRoleSchema = z.enum([
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
export type AssignmentRole = z.infer<typeof assignmentRoleSchema>;

export const assignmentStatusSchema = z.enum([
  'proposed',
  'accepted',
  'declined',
  'active',
  'completed',
  'revoked',
]);
export type AssignmentStatus = z.infer<typeof assignmentStatusSchema>;

export const assignmentProposeSchema = z
  .object({
    serviceRequestId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    assigneeUserId: userIdSchema,
    role: assignmentRoleSchema,
    instructions: z.string().trim().max(8000).nullable().optional(),
    startsAt: isoDateTimeSchema.nullable().optional(),
    endsAt: isoDateTimeSchema.nullable().optional(),
  })
  .refine(
    (v) => Boolean(v.serviceRequestId) !== Boolean(v.projectId),
    'exactly one of serviceRequestId or projectId is required',
  )
  .refine(
    (v) => !v.startsAt || !v.endsAt || new Date(v.startsAt) < new Date(v.endsAt),
    'endsAt must be after startsAt',
  );
export type AssignmentPropose = z.infer<typeof assignmentProposeSchema>;

export const assignmentDeclineSchema = z.object({
  reason: z.string().trim().max(2000).optional(),
});

export const assignmentRevokeSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
});

export const assignmentDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  serviceRequestId: uuidSchema.nullable(),
  projectId: uuidSchema.nullable(),
  assigneeUserId: z.string(),
  assigneeName: z.string().nullable(),
  role: assignmentRoleSchema,
  status: assignmentStatusSchema,
  instructions: z.string().nullable(),
  startsAt: isoDateTimeSchema.nullable(),
  endsAt: isoDateTimeSchema.nullable(),
  assignedBy: z.string().nullable(),
  respondedAt: isoDateTimeSchema.nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type AssignmentDto = z.infer<typeof assignmentDtoSchema>;

export const assignmentListQuerySchema = cursorPaginationQuerySchema
  .extend({
    serviceRequestId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    status: assignmentStatusSchema.optional(),
  })
  .refine(
    (v) => Boolean(v.serviceRequestId) || Boolean(v.projectId),
    'serviceRequestId or projectId is required',
  );
export type AssignmentListQuery = z.infer<typeof assignmentListQuerySchema>;

export const myAssignmentsQuerySchema = cursorPaginationQuerySchema.extend({
  status: assignmentStatusSchema.optional(),
});
export type MyAssignmentsQuery = z.infer<typeof myAssignmentsQuerySchema>;

/* ---------------------------------------------------------------------- */
/* Tasks                                                                   */
/* ---------------------------------------------------------------------- */

export const taskStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskCreateSchema = z
  .object({
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(8000).nullable().optional(),
    serviceRequestId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    assignmentId: uuidSchema.optional(),
    assigneeUserId: userIdSchema.nullable().optional(),
    dueAt: isoDateTimeSchema.nullable().optional(),
    /** Explicit: internal tasks are never shown to customers or partners. */
    visibility: visibilitySchema,
    /** Customer-action tasks appear on the customer home as "awaiting your approval". */
    requiresCustomerAction: z.boolean().default(false),
  })
  .refine(
    (v) => Boolean(v.serviceRequestId || v.projectId || v.assignmentId),
    'a task needs a service request, project or assignment',
  )
  .refine(
    (v) => !v.requiresCustomerAction || v.visibility === 'customer' || v.visibility === 'all',
    'tasks requiring customer action must be visible to the customer',
  );
export type TaskCreate = z.infer<typeof taskCreateSchema>;

export const taskAssignSchema = z.object({
  /** Null clears the assignee. */
  assigneeUserId: userIdSchema.nullable(),
});

export const taskCompleteSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});

export const taskBlockSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
});

export const taskUnblockSchema = z.object({
  reason: z.string().trim().max(2000).optional(),
});

export const taskCancelSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
});

export const taskDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  serviceRequestId: uuidSchema.nullable(),
  projectId: uuidSchema.nullable(),
  assignmentId: uuidSchema.nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: taskStatusSchema,
  dueAt: isoDateTimeSchema.nullable(),
  assigneeUserId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  visibility: visibilitySchema,
  requiresCustomerAction: z.boolean(),
  completedAt: isoDateTimeSchema.nullable(),
  completedBy: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type TaskDto = z.infer<typeof taskDtoSchema>;

export const taskListQuerySchema = cursorPaginationQuerySchema
  .extend({
    serviceRequestId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    assignmentId: uuidSchema.optional(),
    status: taskStatusSchema.optional(),
  })
  .refine(
    (v) => Boolean(v.serviceRequestId || v.projectId || v.assignmentId),
    'serviceRequestId, projectId or assignmentId is required',
  );
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

export const myTasksQuerySchema = cursorPaginationQuerySchema.extend({
  /** Defaults to open tasks (todo, in_progress, blocked). */
  status: taskStatusSchema.optional(),
});
export type MyTasksQuery = z.infer<typeof myTasksQuerySchema>;

/* ---------------------------------------------------------------------- */
/* Notes                                                                   */
/* ---------------------------------------------------------------------- */

export const noteEntityTypeSchema = z.enum([
  'service_request',
  'project',
  'property',
  'lead',
  'site_visit',
  'report',
  'defect',
]);
export type NoteEntityType = z.infer<typeof noteEntityTypeSchema>;

export const entityNoteCreateSchema = z.object({
  entityType: noteEntityTypeSchema,
  entityId: uuidSchema,
  body: z.string().trim().min(1).max(8000),
  /** Required: who may read this note. */
  visibility: visibilitySchema,
});
export type EntityNoteCreate = z.infer<typeof entityNoteCreateSchema>;

export const entityNoteListQuerySchema = cursorPaginationQuerySchema.extend({
  entityType: noteEntityTypeSchema,
  entityId: uuidSchema,
});
export type EntityNoteListQuery = z.infer<typeof entityNoteListQuerySchema>;

export const entityNoteDtoSchema = z.object({
  id: uuidSchema,
  entityType: noteEntityTypeSchema,
  entityId: uuidSchema,
  organizationId: z.string().nullable(),
  body: z.string(),
  visibility: visibilitySchema,
  authorUserId: z.string(),
  authorName: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type EntityNoteDto = z.infer<typeof entityNoteDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Conversations and messages                                              */
/* ---------------------------------------------------------------------- */

export const conversationKindSchema = z.enum([
  'customer_team',
  'tenant_support',
  'partner',
  'internal',
  'support_ticket',
]);
export type ConversationKind = z.infer<typeof conversationKindSchema>;

export const conversationEntityTypeSchema = z.enum([
  'service_request',
  'project',
  'property',
  'lead',
  'site_visit',
  'report',
  'defect',
  // Commercial entities partners work on; their assignees are the invited or named partners.
  'tender',
  'purchase_order',
  'rfq',
]);

export const conversationCreateSchema = z
  .object({
    kind: conversationKindSchema,
    subject: z.string().trim().min(2).max(200),
    entityType: conversationEntityTypeSchema.optional(),
    entityId: uuidSchema.optional(),
    /** Only when no entity is linked: staff name the customer organisation; customers default to their active one. */
    organizationId: z.string().min(1).max(64).optional(),
    /** Every participant must already have access to the linked entity or organisation. */
    participantUserIds: z.array(userIdSchema).min(1).max(50),
    initialMessage: z.string().trim().min(1).max(20_000).optional(),
  })
  .refine(
    (v) => Boolean(v.entityType) === Boolean(v.entityId),
    'entityType and entityId go together',
  );
export type ConversationCreate = z.infer<typeof conversationCreateSchema>;

export const conversationListQuerySchema = cursorPaginationQuerySchema.extend({
  status: z.enum(['open', 'closed', 'all']).default('open'),
  entityType: conversationEntityTypeSchema.optional(),
  entityId: uuidSchema.optional(),
});
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;

export const conversationParticipantDtoSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  role: z.string(),
  joinedAt: isoDateTimeSchema,
  lastReadAt: isoDateTimeSchema.nullable(),
  leftAt: isoDateTimeSchema.nullable(),
});
export type ConversationParticipantDto = z.infer<typeof conversationParticipantDtoSchema>;

export const conversationDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string().nullable(),
  kind: conversationKindSchema,
  subject: z.string(),
  entityType: z.string().nullable(),
  entityId: uuidSchema.nullable(),
  createdBy: z.string().nullable(),
  lastMessageAt: isoDateTimeSchema.nullable(),
  closedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  /** Unread messages for the caller (messages after their lastReadAt, excluding their own). */
  unreadCount: z.number().int().nonnegative(),
});
export type ConversationDto = z.infer<typeof conversationDtoSchema>;

export const conversationDetailSchema = conversationDtoSchema.extend({
  participants: z.array(conversationParticipantDtoSchema),
});
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

export const messageCreateSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  /** file_objects ids the sender may access; storage keys are never exposed. */
  attachmentFileIds: z.array(uuidSchema).max(10).default([]),
  /** Staff only: visible to staff participants alone. */
  internalOnly: z.boolean().default(false),
});
export type MessageCreate = z.infer<typeof messageCreateSchema>;

export const messageListQuerySchema = cursorPaginationQuerySchema;
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;

export const messageDtoSchema = z.object({
  id: uuidSchema,
  conversationId: uuidSchema,
  senderUserId: z.string().nullable(),
  senderName: z.string().nullable(),
  body: z.string(),
  attachmentFileIds: z.array(uuidSchema),
  internalOnly: z.boolean(),
  createdAt: isoDateTimeSchema,
  editedAt: isoDateTimeSchema.nullable(),
});
export type MessageDto = z.infer<typeof messageDtoSchema>;

export const conversationParticipantAddSchema = z.object({
  userId: userIdSchema,
});

export const conversationReadDtoSchema = z.object({
  conversationId: uuidSchema,
  lastReadAt: isoDateTimeSchema,
});
