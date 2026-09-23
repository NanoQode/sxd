import { z } from 'zod';
import { cursorPaginationQuerySchema, isoDateTimeSchema, uuidSchema } from './common';
import {
  messageDeliveryStatusSchema,
  templateDtoSchema,
  templateKeySchema,
  templateStatusSchema,
} from './notifications';
import { notificationCategorySchema, notificationChannelSchema } from './portal';

/**
 * Communications administration (brief §13/§14, acceptance scenario 8) and
 * the signed-in user's phone verification (§10). Recipients in the delivery
 * log and suppression list are masked; one-time codes never appear in any
 * response except the clearly labelled development-adapter echo.
 */

const sampleValueSchema = z.union([z.string().max(2000), z.number()]);
const sampleOverridesSchema = z.record(z.string().max(64), sampleValueSchema);

/* ---------------------------------------------------------------------- */
/* Templates                                                               */
/* ---------------------------------------------------------------------- */

export const sampleVariableSchema = z.object({
  name: z.string(),
  value: z.string(),
  description: z.string(),
  source: z.enum(['catalogue', 'derived', 'override']),
});
export type SampleVariableDto = z.infer<typeof sampleVariableSchema>;

export const smsPricingSchema = z.object({
  unitCostKobo: z.number().int().nonnegative(),
  source: z.enum(['termii_settings', 'default']),
  dailySpendCapKobo: z.number().int().nullable(),
});

export const smsEstimateSchema = z.object({
  segments: z.number().int(),
  encoding: z.enum(['gsm7', 'ucs2']),
  characters: z.number().int(),
  units: z.number().int(),
  unitsPerSegment: z.number().int(),
  remainingInSegment: z.number().int(),
  unicodeCharacters: z.array(z.string()),
  unitCostKobo: z.number().int(),
  unitCostSource: z.enum(['termii_settings', 'default']),
  estimatedCostKobo: z.number().int(),
});
export type SmsEstimateDto = z.infer<typeof smsEstimateSchema>;

/** Preview request: a stored version or unsaved content, with optional sample overrides. */
export const samplePreviewSchema = z
  .object({
    templateId: uuidSchema.optional(),
    template: z
      .object({
        channel: notificationChannelSchema,
        subject: z.string().max(300).nullable().optional(),
        bodyText: z.string().min(1).max(20_000),
        bodyHtml: z.string().max(200_000).nullable().optional(),
      })
      .optional(),
    /** Staff-typed sample values; the server never substitutes customer data. */
    sampleVariables: sampleOverridesSchema.default({}),
  })
  .refine((v) => v.templateId || v.template, { message: 'templateId or template is required' });
export type SamplePreviewInput = z.infer<typeof samplePreviewSchema>;

export const samplePreviewResponseSchema = z.object({
  channel: notificationChannelSchema,
  subject: z.string().nullable(),
  text: z.string(),
  html: z.string().nullable(),
  variables: z.array(z.string()),
  missing: z.array(z.string()),
  samples: z.array(sampleVariableSchema),
  sms: smsEstimateSchema.nullable(),
});
export type SamplePreviewResponse = z.infer<typeof samplePreviewResponseSchema>;

export const templateFamilySummarySchema = z.object({
  key: z.string(),
  channel: notificationChannelSchema,
  locale: z.string(),
  activeVersion: z.number().int().nullable(),
  activeId: uuidSchema.nullable(),
  activeApprovedAt: isoDateTimeSchema.nullable(),
  latestVersion: z.number().int(),
  latestId: uuidSchema,
  latestStatus: templateStatusSchema,
  draftCount: z.number().int(),
  versionCount: z.number().int(),
  updatedAt: isoDateTimeSchema,
});
export type TemplateFamilySummaryDto = z.infer<typeof templateFamilySummarySchema>;

export const templateFamilyDetailSchema = z.object({
  key: z.string(),
  channel: notificationChannelSchema,
  locale: z.string(),
  versions: z.array(templateDtoSchema),
  active: templateDtoSchema.nullable(),
  variables: z.array(sampleVariableSchema),
  sms: smsPricingSchema.nullable(),
});
export type TemplateFamilyDetailDto = z.infer<typeof templateFamilyDetailSchema>;

export const templateRestoreSchema = z.object({
  /** Approve the copy immediately (rollback); otherwise it is saved as a draft. */
  activate: z.boolean().default(false),
  reason: z.string().trim().max(500).optional(),
});
export type TemplateRestoreInput = z.infer<typeof templateRestoreSchema>;

export const templateRestoreResponseSchema = z.object({
  template: templateDtoSchema,
  restoredFrom: z.number().int(),
  previousActiveVersion: z.number().int().nullable(),
});

/* ---------------------------------------------------------------------- */
/* Test send                                                               */
/* ---------------------------------------------------------------------- */

export const communicationsTestSendSchema = z.object({
  channel: z.enum(['email', 'sms']),
  /** Staff-entered address or number, echoed back so the operator sees who received it. */
  to: z.string().trim().min(3).max(254),
  /** Omit for the plain `test_message` template. Other templates render with sample data. */
  templateKey: templateKeySchema.optional(),
  sampleVariables: sampleOverridesSchema.optional(),
});
export type CommunicationsTestSendInput = z.infer<typeof communicationsTestSendSchema>;

/* ---------------------------------------------------------------------- */
/* Delivery log                                                            */
/* ---------------------------------------------------------------------- */

export const timelineStepSchema = z.object({
  state: z.enum([
    'queued',
    'accepted',
    'sent',
    'delivered',
    'failed',
    'bounced',
    'rejected',
    'suppressed',
  ]),
  label: z.string(),
  at: isoDateTimeSchema.nullable(),
});

export const retryBlockReasonSchema = z.enum([
  'already_retried',
  'not_failed',
  'one_time_code',
  'in_app',
  'source_not_retained',
]);

export const deliveryLogItemSchema = z.object({
  id: uuidSchema,
  channel: notificationChannelSchema,
  category: notificationCategorySchema,
  templateKey: z.string().nullable(),
  templateVersion: z.number().int().nullable(),
  /** Masked: `a•••i@example.com`, `+234 ••• ••• 5678`. */
  recipientMasked: z.string(),
  userId: z.string().nullable(),
  provider: z.string(),
  environment: z.string(),
  /** The labelled development adapter handled it: no real message was sent. */
  developmentAdapter: z.boolean(),
  status: messageDeliveryStatusSchema,
  providerMessageId: z.string().nullable(),
  providerStatus: z.string().nullable(),
  errorSanitized: z.string().nullable(),
  segments: z.number().int().nullable(),
  estimatedCostKobo: z.string().nullable(),
  subject: z.string().nullable(),
  isTest: z.boolean(),
  relatedEntityType: z.string().nullable(),
  relatedEntityId: z.string().nullable(),
  attempts: z.number().int(),
  queuedAt: isoDateTimeSchema,
  sentAt: isoDateTimeSchema.nullable(),
  deliveredAt: isoDateTimeSchema.nullable(),
  failedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  timeline: z.array(timelineStepSchema),
  delivery: z.enum(['confirmed', 'awaiting_receipt', 'not_reported', 'failed', 'not_applicable']),
  retry: z.object({ allowed: z.boolean(), reason: retryBlockReasonSchema.nullable() }),
  retryOf: uuidSchema.nullable(),
  retriedBy: uuidSchema.nullable(),
});
export type DeliveryLogItemDto = z.infer<typeof deliveryLogItemSchema>;

export const deliveryLogQuerySchema = cursorPaginationQuerySchema.extend({
  channel: notificationChannelSchema.optional(),
  status: messageDeliveryStatusSchema.optional(),
  templateKey: templateKeySchema.optional(),
  /** Exact email, phone (any format) or user id; partial matches are not supported. */
  recipient: z.string().trim().max(254).optional(),
  testOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  developmentOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});
export type DeliveryLogQuery = z.infer<typeof deliveryLogQuerySchema>;

export const deliveryLogResponseSchema = z.object({
  items: z.array(deliveryLogItemSchema),
  nextCursor: z.string().nullable(),
});

export const communicationsTestSendResponseSchema = z.object({
  /** The address or number the operator entered (not masked: they typed it). */
  to: z.string(),
  outcome: z.object({
    status: z.union([messageDeliveryStatusSchema, z.enum(['skipped', 'deduplicated'])]),
    reason: z.string().nullable(),
    providerMessageId: z.string().nullable(),
  }),
  provider: z.object({
    adapter: z.string(),
    environment: z.string(),
    configured: z.boolean(),
    developmentAdapter: z.boolean(),
    reason: z.string().nullable(),
  }),
  attempt: deliveryLogItemSchema.nullable(),
  samples: z.array(sampleVariableSchema),
});
export type CommunicationsTestSendResponse = z.infer<typeof communicationsTestSendResponseSchema>;

export const deliveryRetryResponseSchema = z.object({
  /** False when an earlier retry exists; nothing new was sent. */
  created: z.boolean(),
  original: deliveryLogItemSchema,
  retry: deliveryLogItemSchema,
});

export const devReceiptSimulateSchema = z.object({
  state: z.enum(['delivered', 'failed', 'rejected']).optional(),
});

export const devReceiptSimulateResponseSchema = z.object({
  action: z.string(),
  attempt: deliveryLogItemSchema,
});

/* ---------------------------------------------------------------------- */
/* Suppressions                                                            */
/* ---------------------------------------------------------------------- */

export const suppressionKindSchema = z.enum(['stop_reply', 'hard_bounce', 'complaint', 'other']);

export const suppressionDtoSchema = z.object({
  id: uuidSchema,
  channel: notificationChannelSchema,
  addressMasked: z.string(),
  reason: z.string(),
  kind: suppressionKindSchema,
  source: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type SuppressionDto = z.infer<typeof suppressionDtoSchema>;

export const suppressionListQuerySchema = cursorPaginationQuerySchema.extend({
  channel: notificationChannelSchema.optional(),
  kind: suppressionKindSchema.optional(),
  /** Exact email or phone (any format). */
  address: z.string().trim().max(254).optional(),
});
export type SuppressionListQuery = z.infer<typeof suppressionListQuerySchema>;

export const suppressionListResponseSchema = z.object({
  items: z.array(suppressionDtoSchema),
  nextCursor: z.string().nullable(),
});

export const suppressionRemoveSchema = z.object({
  reason: z.string().trim().min(3, 'give a reason of at least 3 characters').max(500),
});
export type SuppressionRemoveInput = z.infer<typeof suppressionRemoveSchema>;

export const suppressionRemoveResponseSchema = z.object({
  removed: suppressionDtoSchema,
  /** STOP replies also recorded opted-out consent, which stays until the person opts in again. */
  consentStillOptedOut: z.boolean(),
});

/* ---------------------------------------------------------------------- */
/* Phone verification                                                      */
/* ---------------------------------------------------------------------- */

export const phoneVerificationRequestResponseSchema = z.object({
  status: z.enum(['sent', 'already_verified']),
  phoneMasked: z.string(),
  expiresAt: isoDateTimeSchema.nullable(),
  resendAvailableAt: isoDateTimeSchema.nullable(),
  maxAttempts: z.number().int().nullable(),
  delivery: z
    .object({
      adapter: z.string(),
      /** True when the development adapter handled it: no real SMS was sent. */
      developmentAdapter: z.boolean(),
      label: z.string(),
      /**
       * Development adapter only (APP_ENV development/test): the code, so the flow
       * can be completed locally. Never present with a real provider.
       */
      developmentCode: z.string().nullable(),
    })
    .nullable(),
});
export type PhoneVerificationRequestResponse = z.infer<
  typeof phoneVerificationRequestResponseSchema
>;

export const phoneVerificationConfirmSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'enter the 6-digit code'),
});
export type PhoneVerificationConfirmInput = z.infer<typeof phoneVerificationConfirmSchema>;

export const phoneVerificationConfirmResponseSchema = z.object({
  phoneE164: z.string(),
  phoneVerifiedAt: isoDateTimeSchema,
});
