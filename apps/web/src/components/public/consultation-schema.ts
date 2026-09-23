import { z } from 'zod';

/**
 * Client-side contract for the consultation form. Mirrors
 * consultationRequestSchema from @simplexd/contracts and adds the fields the
 * form needs before payload assembly (preferred times, normalised phone).
 * Pure: unit-tested without React.
 */

export const GOAL_VALUES = [
  'buy_safely',
  'build_with_oversight',
  'manage_property',
  'invest_and_compare',
  'other',
] as const;
export type GoalValue = (typeof GOAL_VALUES)[number];

export const PHONE_E164 = /^\+[1-9]\d{6,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Strips spaces, dots, dashes and brackets; converts a 00 prefix to +. */
export function normalizePhone(raw: string): string {
  let value = raw.trim().replace(/[\s().-]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  return value;
}

export const consultationFormSchema = z
  .object({
    contactName: z.string().trim().min(2, 'Enter your full name').max(120, 'Name is too long'),
    email: z.email('Enter a valid email address').max(254),
    phone: z.string().trim().max(32, 'Phone number is too long'),
    countryOfResidence: z.string().regex(/^([A-Z]{2})?$/, 'Choose a country'),
    timeZone: z.string().trim().min(1, 'Enter your time zone').max(64),
    goal: z.enum(GOAL_VALUES, { error: 'Choose a goal' }),
    serviceSlug: z.string().regex(/^([a-z0-9]+(?:-[a-z0-9]+)*)?$/, 'Choose a service'),
    preferredTimes: z.string().trim().max(500, 'Keep preferred times under 500 characters'),
    message: z.string().trim().max(3000, 'Keep your message under 3,000 characters'),
    marketingConsent: z.boolean(),
    /** Honeypot: humans never see it; anything typed marks the lead for review. */
    website: z.string().max(0, 'Leave this field empty'),
  })
  .superRefine((values, ctx) => {
    if (values.phone && !PHONE_E164.test(normalizePhone(values.phone))) {
      ctx.addIssue({
        code: 'custom',
        path: ['phone'],
        message: 'Use international format with country code, e.g. +2348012345678',
      });
    }
  });

export type ConsultationFormValues = z.infer<typeof consultationFormSchema>;

export interface ConsultationPrefill {
  serviceSlug: string | null;
  goal: GoalValue | null;
  scenarioId: string | null;
  marketIds: string[];
  marketSlug: string | null;
  /** Public listing the visitor is asking about. */
  listingSlug: string | null;
  budgetNaira: number | null;
  /** Interest registration for a planned (not yet bookable) service. */
  interest: boolean;
}

type ParamValue = string | string[] | undefined;

function first(value: ParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function all(value: ParamValue): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : value.split(',')).map((v) => v.trim()).filter(Boolean);
}

/** Reads a validated prefill from URL search params (server or client). */
export function readPrefill(params: Record<string, ParamValue>): ConsultationPrefill {
  const service = first(params.service) ?? '';
  const goal = first(params.goal) ?? '';
  const scenario = first(params.scenarioId) ?? first(params.scenario) ?? '';
  const budgetRaw = first(params.budget) ?? first(params.budgetNaira) ?? '';
  const budget = Number(budgetRaw.replace(/[,_\s]/g, ''));
  const marketIds = [...all(params.marketIds), ...all(params.marketId)].filter((id) =>
    UUID.test(id),
  );
  const marketSlug = first(params.market) ?? '';
  const listingSlug = first(params.listing) ?? '';
  return {
    serviceSlug: SLUG.test(service) ? service : null,
    goal: (GOAL_VALUES as readonly string[]).includes(goal) ? (goal as GoalValue) : null,
    scenarioId: UUID.test(scenario) ? scenario.toLowerCase() : null,
    marketIds: [...new Set(marketIds.map((m) => m.toLowerCase()))].slice(0, 10),
    marketSlug: SLUG.test(marketSlug) ? marketSlug : null,
    listingSlug: SLUG.test(listingSlug) ? listingSlug : null,
    budgetNaira: Number.isFinite(budget) && budget > 0 && budget <= 1e13 ? budget : null,
    interest: first(params.interest) === '1' || first(params.interest) === 'true',
  };
}

export interface PayloadContext {
  prefill: ConsultationPrefill;
  elapsedMs: number;
  source: 'website_form' | 'consultation_booking';
  consentPolicyVersion?: string;
}

export interface ConsultationPayload {
  contactName: string;
  email: string;
  phoneE164: string | null;
  countryOfResidence: string | null;
  timeZone: string | null;
  goal: GoalValue;
  serviceSlug: string | null;
  message: string | null;
  scenarioId: string | null;
  marketIds: string[];
  budgetNaira: number | null;
  marketingConsent: boolean;
  consentPolicyVersion: string;
  website?: string;
  elapsedMs: number;
  source: 'website_form' | 'consultation_booking';
}

const MESSAGE_LIMIT = 4000;

export function composeMessage(values: {
  message: string;
  preferredTimes: string;
  timeZone: string;
  interest: boolean;
  marketSlug: string | null;
  listingSlug?: string | null;
}): string | null {
  const parts: string[] = [];
  if (values.interest)
    parts.push('Interest registration for a planned service (not yet bookable).');
  if (values.marketSlug) parts.push(`Location of interest: ${values.marketSlug}`);
  if (values.listingSlug) parts.push(`Listing of interest: ${values.listingSlug}`);
  if (values.message.trim()) parts.push(values.message.trim());
  if (values.preferredTimes.trim()) {
    parts.push(
      `Preferred days and times (${values.timeZone || 'time zone not given'}): ${values.preferredTimes.trim()}`,
    );
  }
  const joined = parts.join('\n\n');
  if (!joined) return null;
  return joined.length > MESSAGE_LIMIT ? joined.slice(0, MESSAGE_LIMIT) : joined;
}

/** Assembles the wire payload for POST /api/v1/leads/consultation. */
export function buildConsultationPayload(
  values: ConsultationFormValues,
  ctx: PayloadContext,
): ConsultationPayload {
  const phone = values.phone ? normalizePhone(values.phone) : '';
  return {
    contactName: values.contactName.trim(),
    email: values.email.trim().toLowerCase(),
    phoneE164: phone ? phone : null,
    countryOfResidence: values.countryOfResidence || null,
    timeZone: values.timeZone.trim() || null,
    goal: values.goal,
    serviceSlug: values.serviceSlug || null,
    message: composeMessage({
      message: values.message,
      preferredTimes: values.preferredTimes,
      timeZone: values.timeZone,
      interest: ctx.prefill.interest,
      marketSlug: ctx.prefill.marketSlug,
      listingSlug: ctx.prefill.listingSlug,
    }),
    scenarioId: ctx.prefill.scenarioId,
    marketIds: ctx.prefill.marketIds,
    budgetNaira: ctx.prefill.budgetNaira,
    marketingConsent: values.marketingConsent,
    consentPolicyVersion: ctx.consentPolicyVersion ?? '2026-09',
    ...(values.website ? { website: values.website } : {}),
    elapsedMs: Math.max(0, Math.round(ctx.elapsedMs)),
    source: ctx.source,
  };
}

/** Maps API validation detail paths back to form field names. */
export function fieldForApiPath(path: string): keyof ConsultationFormValues | null {
  switch (path) {
    case 'contactName':
      return 'contactName';
    case 'email':
      return 'email';
    case 'phoneE164':
      return 'phone';
    case 'countryOfResidence':
      return 'countryOfResidence';
    case 'timeZone':
      return 'timeZone';
    case 'goal':
      return 'goal';
    case 'serviceSlug':
      return 'serviceSlug';
    case 'message':
      return 'message';
    case 'marketingConsent':
      return 'marketingConsent';
    default:
      return null;
  }
}
