import { z } from 'zod';
import { cursorPaginationQuerySchema, emailSchema, isoDateTimeSchema, uuidSchema } from './common';
import { notificationCategorySchema, notificationChannelSchema } from './portal';

/**
 * Notification contracts: the in-app feed, admin template lifecycle, test
 * sends, the delivery log and provider status (brief §13/§14). Secrets and
 * provider settings never appear in any of these shapes.
 */

export type NotificationChannel = z.infer<typeof notificationChannelSchema>;
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

export const messageDeliveryStatusSchema = z.enum([
  'queued',
  'accepted',
  'sent',
  'delivered',
  'failed',
  'suppressed',
  'bounced',
  'rejected',
]);
export type MessageDeliveryStatus = z.infer<typeof messageDeliveryStatusSchema>;

export const templateStatusSchema = z.enum(['draft', 'approved', 'retired']);
export type TemplateStatus = z.infer<typeof templateStatusSchema>;

/* ---------------------------------------------------------------------- */
/* In-app feed                                                             */
/* ---------------------------------------------------------------------- */

export const notificationDtoSchema = z.object({
  id: uuidSchema,
  category: notificationCategorySchema,
  kind: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  linkPath: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  readAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type NotificationDto = z.infer<typeof notificationDtoSchema>;

export const notificationFeedQuerySchema = cursorPaginationQuerySchema.extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type NotificationFeedQuery = z.infer<typeof notificationFeedQuerySchema>;

export const notificationFeedResponseSchema = z.object({
  items: z.array(notificationDtoSchema),
  nextCursor: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
});

export const unreadCountResponseSchema = z.object({ unreadCount: z.number().int().nonnegative() });
export const readAllResponseSchema = z.object({ marked: z.number().int().nonnegative() });

/* ---------------------------------------------------------------------- */
/* Templates                                                               */
/* ---------------------------------------------------------------------- */

export const templateKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,63}$/, 'snake_case template key');

export const templateDtoSchema = z.object({
  id: uuidSchema,
  key: templateKeySchema,
  channel: notificationChannelSchema,
  locale: z.string(),
  version: z.number().int().min(1),
  subject: z.string().nullable(),
  bodyText: z.string(),
  bodyHtml: z.string().nullable(),
  variables: z.array(z.string()),
  status: templateStatusSchema,
  approvedBy: z.string().nullable(),
  approvedAt: isoDateTimeSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type TemplateDto = z.infer<typeof templateDtoSchema>;

export const templateListQuerySchema = z.object({
  key: templateKeySchema.optional(),
  channel: notificationChannelSchema.optional(),
  status: templateStatusSchema.optional(),
  locale: z.string().max(16).optional(),
});
export type TemplateListQuery = z.infer<typeof templateListQuerySchema>;

export const templateCreateSchema = z.object({
  key: templateKeySchema,
  channel: notificationChannelSchema,
  locale: z.string().min(2).max(16).default('en'),
  subject: z.string().trim().max(300).nullable().optional(),
  bodyText: z.string().min(1).max(20_000),
  bodyHtml: z.string().max(200_000).nullable().optional(),
});
export type TemplateCreate = z.infer<typeof templateCreateSchema>;

export const templateUpdateSchema = z.object({
  subject: z.string().trim().max(300).nullable().optional(),
  bodyText: z.string().min(1).max(20_000).optional(),
  bodyHtml: z.string().max(200_000).nullable().optional(),
  expectedUpdatedAt: isoDateTimeSchema.optional(),
});
export type TemplateUpdate = z.infer<typeof templateUpdateSchema>;

export const templateActionSchema = z.object({
  action: z.enum(['approve', 'retire', 'reopen']),
});
export type TemplateActionInput = z.infer<typeof templateActionSchema>;

const sampleVariablesSchema = z.record(
  z.string().max(64),
  z.union([z.string().max(2000), z.number()]),
);

export const templatePreviewSchema = z
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
    sampleVariables: sampleVariablesSchema.default({}),
  })
  .refine((v) => v.templateId || v.template, { message: 'templateId or template is required' });
export type TemplatePreviewInput = z.infer<typeof templatePreviewSchema>;

export const templatePreviewResponseSchema = z.object({
  channel: notificationChannelSchema,
  subject: z.string().nullable(),
  text: z.string(),
  html: z.string().nullable(),
  variables: z.array(z.string()),
  missing: z.array(z.string()),
  sms: z
    .object({ segments: z.number().int(), encoding: z.string(), characters: z.number().int() })
    .nullable(),
});

/* ---------------------------------------------------------------------- */
/* Test send and delivery log                                              */
/* ---------------------------------------------------------------------- */

export const testSendSchema = z.object({
  channel: z.enum(['email', 'sms']),
  /** Staff-entered address or phone number; echoed back so the operator sees exactly who received it. */
  to: z.string().trim().min(3).max(254),
  templateKey: templateKeySchema.optional(),
  variables: sampleVariablesSchema.optional(),
});
export type TestSendInput = z.infer<typeof testSendSchema>;

export const deliveryAttemptDtoSchema = z.object({
  id: uuidSchema,
  channel: notificationChannelSchema,
  category: notificationCategorySchema,
  templateKey: z.string().nullable(),
  templateVersion: z.number().int().nullable(),
  recipient: z.string(),
  userId: z.string().nullable(),
  provider: z.string(),
  environment: z.string(),
  status: messageDeliveryStatusSchema,
  providerMessageId: z.string().nullable(),
  providerStatus: z.string().nullable(),
  errorSanitized: z.string().nullable(),
  segments: z.number().int().nullable(),
  estimatedCostKobo: z.string().nullable(),
  relatedEntityType: z.string().nullable(),
  relatedEntityId: z.string().nullable(),
  subject: z.string().nullable(),
  isTest: z.boolean(),
  attempts: z.number().int(),
  queuedAt: isoDateTimeSchema,
  sentAt: isoDateTimeSchema.nullable(),
  deliveredAt: isoDateTimeSchema.nullable(),
  failedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type DeliveryAttemptDto = z.infer<typeof deliveryAttemptDtoSchema>;

export const testSendResponseSchema = z.object({
  outcome: z.object({
    attemptId: uuidSchema.nullable(),
    channel: notificationChannelSchema,
    recipient: z.string(),
    status: z.union([messageDeliveryStatusSchema, z.enum(['skipped', 'deduplicated'])]),
    reason: z.string().nullable(),
    providerMessageId: z.string().nullable().optional(),
  }),
  attempt: deliveryAttemptDtoSchema.nullable(),
  provider: z.object({
    adapter: z.string(),
    environment: z.string(),
    configured: z.boolean(),
    reason: z.string().nullable(),
  }),
});

export const deliveryAttemptListQuerySchema = cursorPaginationQuerySchema.extend({
  channel: notificationChannelSchema.optional(),
  status: messageDeliveryStatusSchema.optional(),
  templateKey: templateKeySchema.optional(),
  recipient: z.string().trim().max(254).optional(),
  userId: z.string().max(128).optional(),
  provider: z.string().max(32).optional(),
  testOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});
export type DeliveryAttemptListQuery = z.infer<typeof deliveryAttemptListQuerySchema>;

export const deliveryAttemptListResponseSchema = z.object({
  items: z.array(deliveryAttemptDtoSchema),
  nextCursor: z.string().nullable(),
});

export const providerStatusDtoSchema = z.object({
  provider: z.enum(['smtp', 'termii']),
  channel: z.enum(['email', 'sms']),
  environment: z.enum(['test', 'live']),
  status: z.enum([
    'disconnected',
    'configured_unverified',
    'connected',
    'degraded',
    'expired',
    'disabled',
  ]),
  adapter: z.string(),
  enabled: z.boolean(),
  configured: z.boolean(),
  devFallback: z.boolean(),
  lastCheckAt: isoDateTimeSchema.nullable(),
  lastCheckOk: z.boolean().nullable(),
  lastCheckMessage: z.string().nullable(),
  lastSuccessAt: isoDateTimeSchema.nullable(),
  activatedAt: isoDateTimeSchema.nullable(),
  credentialRotatedAt: isoDateTimeSchema.nullable(),
  last24h: z.record(z.string(), z.number().int()),
});
export type ProviderStatusDto = z.infer<typeof providerStatusDtoSchema>;

export const providerStatusResponseSchema = z.object({ items: z.array(providerStatusDtoSchema) });

/* ---------------------------------------------------------------------- */
/* Webhooks                                                                */
/* ---------------------------------------------------------------------- */

export const termiiWebhookAckSchema = z.object({
  accepted: z.boolean(),
  signature: z.enum(['valid', 'invalid', 'unchecked']),
  eventType: z.string(),
  action: z.string(),
});
export type TermiiWebhookAck = z.infer<typeof termiiWebhookAckSchema>;

/** Manual bounce import (no SMTP bounce webhook is configured yet). */
export const bounceImportSchema = z.object({
  email: emailSchema,
  kind: z.enum(['hard', 'soft', 'complaint']).default('hard'),
  reason: z.string().max(500).nullable().optional(),
  providerMessageId: z.string().max(200).nullable().optional(),
});
export type BounceImport = z.infer<typeof bounceImportSchema>;
