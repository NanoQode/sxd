import { z } from 'zod';
import {
  cursorPaginationQuerySchema,
  emailSchema,
  expectedVersionSchema,
  isoDateTimeSchema,
  slugSchema,
  timeZoneSchema,
  uuidSchema,
} from './common';
import {
  contentKindSchema,
  contentPageDtoSchema,
  contentRevisionDtoSchema,
  contentRevisionInputSchema,
  contentStatusSchema,
} from './content';
import { leadDtoSchema, leadStatusSchema } from './leads';

/**
 * Customer portal, onboarding, CRM administration and CMS administration
 * contracts. Money on the wire stays integer kobo as strings; scenario and
 * budget figures entered by customers are whole naira numbers.
 */

/* ---------------------------------------------------------------------- */
/* Service requests (customer intake)                                      */
/* ---------------------------------------------------------------------- */

export const engagementStatusSchema = z.enum([
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
export type EngagementStatus = z.infer<typeof engagementStatusSchema>;

export const preferredTimelineSchema = z.enum([
  'as_soon_as_possible',
  'within_1_month',
  'within_3_months',
  'within_6_months',
  'exploring',
]);
export type PreferredTimeline = z.infer<typeof preferredTimelineSchema>;

export const PREFERRED_TIMELINE_LABELS: Record<PreferredTimeline, string> = {
  as_soon_as_possible: 'As soon as possible',
  within_1_month: 'Within 1 month',
  within_3_months: 'Within 3 months',
  within_6_months: 'Within 6 months',
  exploring: 'Still exploring',
};

export const serviceRequestCreateSchema = z.object({
  serviceSlug: slugSchema,
  title: z.string().trim().min(3).max(160).optional(),
  description: z.string().trim().min(10).max(8000),
  marketId: uuidSchema.nullable().optional(),
  scenarioId: uuidSchema.nullable().optional(),
  budgetNaira: z.number().positive().max(1e13).nullable().optional(),
  preferredTimeline: preferredTimelineSchema.nullable().optional(),
  /** Answers keyed by the workflow template's intake keys. */
  intake: z.record(z.string().max(64), z.string().trim().max(2000)).default({}),
});
export type ServiceRequestCreate = z.infer<typeof serviceRequestCreateSchema>;

/** Transitions a customer may request. Staff transitions arrive in Wave 2. */
export const customerTransitionTargetSchema = z.enum(['cancelled', 'paused', 'in_progress']);

export const serviceRequestTransitionSchema = z.object({
  to: customerTransitionTargetSchema,
  reason: z.string().trim().max(2000).optional(),
  expectedVersion: expectedVersionSchema,
});
export type ServiceRequestTransition = z.infer<typeof serviceRequestTransitionSchema>;

export const serviceRequestNoteCreateSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

export const serviceRequestListQuerySchema = cursorPaginationQuerySchema.extend({
  status: engagementStatusSchema.optional(),
});
export type ServiceRequestListQuery = z.infer<typeof serviceRequestListQuerySchema>;

export const userRefSchema = z.object({ id: z.string(), name: z.string() });

export const serviceRequestDtoSchema = z.object({
  id: uuidSchema,
  reference: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: engagementStatusSchema,
  serviceId: uuidSchema,
  serviceSlug: z.string(),
  serviceName: z.string(),
  marketId: uuidSchema.nullable(),
  marketName: z.string().nullable(),
  scenarioId: uuidSchema.nullable(),
  budgetNaira: z.number().nullable(),
  preferredTimeline: preferredTimelineSchema.nullable(),
  intake: z.record(z.string(), z.string()),
  assignedPm: userRefSchema.nullable(),
  priority: z.number().int(),
  pauseReason: z.string().nullable(),
  cancelReason: z.string().nullable(),
  rejectReason: z.string().nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type ServiceRequestDto = z.infer<typeof serviceRequestDtoSchema>;

export const engagementTransitionDtoSchema = z.object({
  id: uuidSchema,
  fromStatus: engagementStatusSchema.nullable(),
  toStatus: engagementStatusSchema,
  actorType: z.string(),
  actorName: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type EngagementTransitionDto = z.infer<typeof engagementTransitionDtoSchema>;

export const noteDtoSchema = z.object({
  id: uuidSchema,
  body: z.string(),
  visibility: z.enum(['internal', 'customer', 'partner', 'all']),
  authorName: z.string().nullable(),
  authorUserId: z.string(),
  createdAt: isoDateTimeSchema,
});
export type NoteDto = z.infer<typeof noteDtoSchema>;

export const availableTransitionDtoSchema = z.object({
  to: engagementStatusSchema,
  reasonRequired: z.boolean(),
  effect: z.string().nullable(),
});

export const serviceRequestDetailSchema = serviceRequestDtoSchema.extend({
  transitions: z.array(engagementTransitionDtoSchema),
  notes: z.array(noteDtoSchema),
  availableTransitions: z.array(availableTransitionDtoSchema),
});
export type ServiceRequestDetail = z.infer<typeof serviceRequestDetailSchema>;

export const bookableServiceDtoSchema = z.object({
  id: uuidSchema,
  slug: z.string(),
  name: z.string(),
  category: z.enum(['core', 'expansion']),
  shortDescription: z.string(),
  deliverables: z.array(z.string()),
  workflowTemplateKey: z.string(),
  /** Intake checklist keys from the workflow template. */
  intakeKeys: z.array(z.string()),
  /** True when the service is published, staffed for booking and its flag (if any) is enabled. */
  bookable: z.boolean(),
  /** True when interest can be registered as a lead instead. */
  inquiryEnabled: z.boolean(),
  startingPrice: z
    .object({
      basis: z.enum(['fixed', 'from', 'per_month', 'percentage', 'quotation']),
      amountKobo: z.string().nullable(),
      percentageBps: z.number().int().nullable(),
    })
    .nullable(),
});
export type BookableServiceDto = z.infer<typeof bookableServiceDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Notification preferences                                                */
/* ---------------------------------------------------------------------- */

export const notificationChannelSchema = z.enum(['email', 'sms', 'in_app']);
export const notificationCategorySchema = z.enum([
  'security',
  'transactional',
  'reminders',
  'digests',
  'marketing',
]);
export const digestFrequencySchema = z.enum(['none', 'daily', 'weekly']);

export const notificationPreferenceItemSchema = z.object({
  channel: notificationChannelSchema,
  category: notificationCategorySchema,
  enabled: z.boolean(),
  digest: digestFrequencySchema.default('none'),
});
export type NotificationPreferenceItem = z.infer<typeof notificationPreferenceItemSchema>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

export const notificationPreferencesUpdateSchema = z.object({
  items: z.array(notificationPreferenceItemSchema).max(15),
  quietHours: z.object({ start: hhmm, end: hhmm }).nullable().default(null),
  timeZone: timeZoneSchema.optional(),
});
export type NotificationPreferencesUpdate = z.infer<typeof notificationPreferencesUpdateSchema>;

export const notificationPreferencesDtoSchema = z.object({
  items: z.array(notificationPreferenceItemSchema),
  quietHours: z.object({ start: hhmm, end: hhmm }).nullable(),
  timeZone: z.string().nullable(),
  /** Security messages follow product policy and cannot be switched off. */
  lockedCategories: z.array(notificationCategorySchema),
});
export type NotificationPreferencesDto = z.infer<typeof notificationPreferencesDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Organisations, invitations and profile                                  */
/* ---------------------------------------------------------------------- */

export const orgRoleSchema = z.enum(['owner', 'member', 'adviser', 'approver', 'tenant']);
export const invitableOrgRoleSchema = z.enum(['owner', 'member', 'adviser', 'approver']);
export type InvitableOrgRole = z.infer<typeof invitableOrgRoleSchema>;

export const ORG_ROLE_DESCRIPTIONS: Record<InvitableOrgRole, string> = {
  owner: 'Full control: settings, members, approvals, payments and cancellations.',
  member: 'Can create requests, upload documents, pay invoices and message the team.',
  adviser: 'View and comment on documents, reports and invoices; cannot approve or pay.',
  approver: 'Can accept quotes, approve change orders and milestones; cannot change settings.',
};

export const organizationMembershipDtoSchema = z.object({
  organizationId: z.string(),
  name: z.string(),
  slug: z.string(),
  role: orgRoleSchema,
  kind: z.enum(['customer', 'staff', 'partner', 'estate']),
  ownershipType: z.enum(['individual', 'company']),
  isActive: z.boolean(),
  createdAt: isoDateTimeSchema,
});
export type OrganizationMembershipDto = z.infer<typeof organizationMembershipDtoSchema>;

export const organizationUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    ownershipType: z.enum(['individual', 'company']).optional(),
    legalName: z.string().trim().max(200).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

export const organizationInviteSchema = z.object({
  email: emailSchema,
  role: invitableOrgRoleSchema,
});

export const organizationInvitationDtoSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
  status: z.string(),
  expiresAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  inviterName: z.string().nullable(),
});
export type OrganizationInvitationDto = z.infer<typeof organizationInvitationDtoSchema>;

export const organizationMemberDtoSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: orgRoleSchema,
  createdAt: isoDateTimeSchema,
});
export type OrganizationMemberDto = z.infer<typeof organizationMemberDtoSchema>;

export const phoneUpdateSchema = z.object({
  /** Free-form input; the server normalises to E.164 or rejects. Null clears the number. */
  phone: z.string().trim().max(32).nullable(),
  /** ISO 3166-1 alpha-2 default region for national-format input. */
  defaultCountry: z.string().length(2).default('NG'),
});

export const onboardingCompleteSchema = z.object({
  goals: z.array(z.string().max(64)).max(10).optional(),
});

export const accountDeletionRequestSchema = z.object({
  confirmEmail: emailSchema,
  reason: z.string().trim().max(2000).optional(),
});

export const consentDtoSchema = z.object({
  id: uuidSchema,
  purpose: z.string(),
  granted: z.boolean(),
  policyVersion: z.string(),
  source: z.string(),
  recordedAt: isoDateTimeSchema,
});
export type ConsentDto = z.infer<typeof consentDtoSchema>;

export const CONSENT_PURPOSES = [
  'privacy_notice',
  'marketing_email',
  'marketing_sms',
  'analytics',
  'identity_documents',
  'screening',
] as const;

/** Body of POST /api/v1/me/consents: one append-only consent decision. */
export const consentRecordSchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  granted: z.boolean(),
  source: z.string().max(64).default('portal'),
  policyVersion: z.string().max(32).default('2026-09'),
});
export type ConsentRecordInput = z.infer<typeof consentRecordSchema>;

/**
 * Body of PATCH /api/v1/me/preferences. The route additionally checks the time
 * zone against the runtime's IANA database.
 */
export const profilePreferencesUpdateSchema = z
  .object({
    themePreference: z.enum(['system', 'light', 'dark']).optional(),
    reduceMotion: z.boolean().optional(),
    timeZone: timeZoneSchema.optional(),
    locale: z.string().min(2).max(16).optional(),
    goals: z.array(z.string().max(64)).max(10).optional(),
    diaspora: z.boolean().optional(),
    countryOfResidence: z.string().length(2).optional(),
    ownershipType: z.enum(['individual', 'company']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type ProfilePreferencesUpdate = z.infer<typeof profilePreferencesUpdateSchema>;

export const GOAL_OPTIONS = [
  { value: 'buy_safely', label: 'Buy safely' },
  { value: 'build_with_oversight', label: 'Build with oversight' },
  { value: 'manage_property', label: 'Manage my property' },
  { value: 'invest_and_compare', label: 'Invest and compare' },
] as const;

/* ---------------------------------------------------------------------- */
/* CRM administration                                                      */
/* ---------------------------------------------------------------------- */

export const leadNoteCreateSchema = z.object({ body: z.string().trim().min(1).max(4000) });

export const leadConvertSchema = z.object({
  serviceSlug: slugSchema.optional(),
  title: z.string().trim().min(3).max(160).optional(),
  note: z.string().trim().max(2000).optional(),
});
export type LeadConvert = z.infer<typeof leadConvertSchema>;

export const leadConvertResultSchema = z.object({
  path: z.enum(['service_request_created', 'invitation_sent']),
  serviceRequestId: uuidSchema.nullable(),
  reference: z.string().nullable(),
  organizationId: z.string().nullable(),
  leadStatus: leadStatusSchema,
});
export type LeadConvertResult = z.infer<typeof leadConvertResultSchema>;

export const leadDetailDtoSchema = leadDtoSchema.extend({
  interestServiceSlug: z.string().nullable(),
  markets: z.array(z.object({ id: uuidSchema, name: z.string(), stateName: z.string() })),
  budgetNaira: z.number().nullable(),
  scenario: z.object({ id: uuidSchema, name: z.string(), objective: z.string() }).nullable(),
  linkedUser: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable(),
  organizationName: z.string().nullable(),
  notes: z.array(noteDtoSchema),
  convertedReference: z.string().nullable(),
  suspicious: z.boolean(),
});
export type LeadDetailDto = z.infer<typeof leadDetailDtoSchema>;

export const staffAssigneeDtoSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  roles: z.array(z.string()),
});
export type StaffAssigneeDto = z.infer<typeof staffAssigneeDtoSchema>;

/* ---------------------------------------------------------------------- */
/* CMS administration                                                      */
/* ---------------------------------------------------------------------- */

export const contentListQuerySchema = cursorPaginationQuerySchema.extend({
  kind: contentKindSchema.optional(),
  status: contentStatusSchema.optional(),
  q: z.string().max(80).optional(),
});
export type ContentListQuery = z.infer<typeof contentListQuerySchema>;

export const contentRevisionCreateSchema = contentRevisionInputSchema.extend({
  expectedVersion: expectedVersionSchema,
});
export type ContentRevisionCreate = z.infer<typeof contentRevisionCreateSchema>;

export const contentPreviewRenderSchema = z.object({ markdown: z.string().max(200_000) });

export const contentPageDetailSchema = contentPageDtoSchema.extend({
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  unpublishedAt: isoDateTimeSchema.nullable(),
  relatedEntityType: z.string().nullable(),
  relatedEntityId: uuidSchema.nullable(),
  revisions: z.array(contentRevisionDtoSchema.extend({ createdByName: z.string().nullable() })),
});
export type ContentPageDetail = z.infer<typeof contentPageDetailSchema>;

export const mediaAssetDtoSchema = z.object({
  id: uuidSchema,
  fileId: uuidSchema,
  altText: z.string(),
  caption: z.string().nullable(),
  originalName: z.string(),
  declaredMime: z.string(),
  approvedForPublic: z.boolean(),
  rightsConfirmed: z.boolean(),
  createdAt: isoDateTimeSchema,
});
export type MediaAssetDto = z.infer<typeof mediaAssetDtoSchema>;

export const redirectDtoSchema = z.object({
  id: uuidSchema,
  fromPath: z.string(),
  toPath: z.string(),
  statusCode: z.number().int(),
  active: z.boolean(),
  note: z.string().nullable(),
  hitCount: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type RedirectDto = z.infer<typeof redirectDtoSchema>;

export const redirectPatchSchema = z
  .object({
    active: z.boolean().optional(),
    toPath: z
      .string()
      .regex(/^\/[^\s]*$|^https:\/\/[^\s]+$/, 'relative path or https URL')
      .optional(),
    statusCode: z.union([z.literal(301), z.literal(302), z.literal(308)]).optional(),
    note: z.string().max(200).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

/** Structured field shapes per content kind, used by the editor's fields panel. */
export const CONTENT_FIELD_TEMPLATES: Partial<
  Record<z.infer<typeof contentKindSchema>, Record<string, unknown>>
> = {
  faq: { question: '', answer: '' },
  service: { overrides: { shortDescription: '', deliverables: [] } },
  contact: { email: null, phone: null, address: null, note: '' },
  navigation: { items: [{ label: '', href: '' }] },
  banner: { message: '', href: null, tone: 'info', startsAt: null, endsAt: null },
  goal_path: { key: '', description: '', href: '' },
  evidence_standard: { badges: [{ key: '', label: '', meaning: '' }] },
  policy: { reviewStatus: 'template_pending_legal_review', effectiveDate: null },
};
