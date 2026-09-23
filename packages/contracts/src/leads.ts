import { z } from 'zod';
import {
  emailSchema,
  isoDateTimeSchema,
  phoneE164Schema,
  slugSchema,
  timeZoneSchema,
  uuidSchema,
} from './common';

/** Consultation requests, quote requests and leads. Public forms carry abuse controls. */

export const leadSourceSchema = z.enum([
  'website_form',
  'consultation_booking',
  'map_scenario',
  'referral',
  'manual',
  'quote_request',
]);

export const leadStatusSchema = z.enum([
  'new',
  'contacted',
  'qualified',
  'converted',
  'closed_lost',
  'spam',
]);

export const consultationRequestSchema = z.object({
  contactName: z.string().trim().min(2).max(120),
  email: emailSchema,
  phoneE164: phoneE164Schema.nullable().optional(),
  countryOfResidence: z.string().length(2).nullable().optional(),
  timeZone: timeZoneSchema.nullable().optional(),
  goal: z
    .enum(['buy_safely', 'build_with_oversight', 'manage_property', 'invest_and_compare', 'other'])
    .default('other'),
  serviceSlug: slugSchema.nullable().optional(),
  message: z.string().trim().max(4000).nullable().optional(),
  scenarioId: uuidSchema.nullable().optional(),
  marketIds: z.array(uuidSchema).max(10).default([]),
  budgetNaira: z.number().positive().max(1e13).nullable().optional(),
  marketingConsent: z.boolean().default(false),
  consentPolicyVersion: z.string().max(32).default('2026-09'),
  /** Honeypot: must stay empty. */
  website: z.string().max(0).optional(),
  /** Milliseconds between form render and submit; too fast is treated as spam. */
  elapsedMs: z.number().int().nonnegative().optional(),
});
export type ConsultationRequest = z.infer<typeof consultationRequestSchema>;

export const leadDtoSchema = z.object({
  id: uuidSchema,
  contactName: z.string(),
  email: z.string(),
  phoneE164: z.string().nullable(),
  countryOfResidence: z.string().nullable(),
  timeZone: z.string().nullable(),
  source: leadSourceSchema,
  goal: z.string().nullable(),
  interestServiceId: uuidSchema.nullable(),
  interestServiceName: z.string().nullable(),
  message: z.string().nullable(),
  scenarioId: uuidSchema.nullable(),
  context: z.unknown().nullable(),
  status: leadStatusSchema,
  assignedToUserId: z.string().nullable(),
  assignedToName: z.string().nullable(),
  convertedServiceRequestId: uuidSchema.nullable(),
  marketingConsent: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type LeadDto = z.infer<typeof leadDtoSchema>;

export const leadUpdateSchema = z.object({
  status: leadStatusSchema.optional(),
  assignedToUserId: z.string().nullable().optional(),
  note: z.string().max(4000).optional(),
});

export const leadListQuerySchema = z.object({
  status: leadStatusSchema.optional(),
  assignedToUserId: z.string().optional(),
  q: z.string().max(80).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
