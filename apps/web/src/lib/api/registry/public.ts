import { z } from 'zod';
import {
  consultationRequestSchema,
  listRoutes,
  registerRoute,
  type RouteSpec,
} from '@simplexd/contracts';

/**
 * OpenAPI registration for the public website endpoints. Registration is
 * idempotent so hot reloads and test re-imports never trip the duplicate
 * operationId guard.
 */

function ensure(spec: RouteSpec): RouteSpec {
  const existing = listRoutes().find((r) => r.operationId === spec.operationId);
  return existing ?? registerRoute(spec);
}

export const publicConsultationBodySchema = consultationRequestSchema.extend({
  source: z
    .enum(['website_form', 'consultation_booking', 'map_scenario', 'quote_request'])
    .default('website_form'),
});
export type PublicConsultationBody = z.infer<typeof publicConsultationBodySchema>;

export const consultationResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('received'),
});

export const publicServiceSchema = z.object({
  slug: z.string(),
  name: z.string(),
  category: z.enum(['core', 'expansion']),
  shortDescription: z.string(),
  deliverables: z.array(z.string()),
  completionEvidence: z.string().nullable(),
  availability: z.enum(['request', 'inquiry_only']),
  bookable: z.boolean(),
  priceLabel: z.string().nullable(),
  priceBasis: z.enum(['fixed', 'from', 'per_month', 'percentage', 'quotation']).nullable(),
  packagePublicationState: z.enum(['draft', 'in_review', 'published', 'retired']).nullable(),
  href: z.string(),
});

export const publicServicesResponseSchema = z.object({
  items: z.array(publicServiceSchema),
  generatedAt: z.string(),
});

const eventNameSchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, 'snake_case event name');
const propValue = z.union([z.string().max(200), z.number().finite(), z.boolean()]);

export const analyticsEventBodySchema = z.object({
  eventName: eventNameSchema,
  path: z
    .string()
    .max(300)
    .regex(/^\/[^\s]*$/, 'path must start with /'),
  props: z.record(z.string().max(64), propValue).optional(),
  /** Random per-browser-session identifier; stored only as a keyed hash. */
  sessionId: z.string().min(8).max(64),
});
export type AnalyticsEventBody = z.infer<typeof analyticsEventBodySchema>;

export const consultationLeadRoute = ensure({
  method: 'post',
  path: '/api/v1/leads/consultation',
  summary: 'Submit a consultation request',
  description:
    'Public form endpoint. Rate limited per hashed IP (5/hour) and per email (3/hour). Spam heuristics mark the lead for review; the response never reveals the classification.',
  tags: ['public', 'leads'],
  operationId: 'public.leads.consultation.create',
  auth: 'public',
  request: { body: publicConsultationBodySchema },
  responses: {
    201: { description: 'Request received', body: consultationResponseSchema },
    400: { description: 'Validation failed' },
    429: { description: 'Rate limited' },
  },
});

export const publicServicesRoute = ensure({
  method: 'get',
  path: '/api/v1/services',
  summary: 'Public service catalogue',
  description:
    'Eight core services with their price anchors (published figures or an "under business review" label) and the planned expansion services flagged inquiry-only.',
  tags: ['public', 'services'],
  operationId: 'public.services.list',
  auth: 'public',
  responses: { 200: { description: 'Catalogue', body: publicServicesResponseSchema } },
});

export const analyticsEventRoute = ensure({
  method: 'post',
  path: '/api/v1/analytics/events',
  summary: 'Record a consent-aware analytics event',
  description:
    'Accepted only when the sx_consent=analytics cookie is present. Payloads containing email-like strings are rejected. The session id is stored as a keyed hash.',
  tags: ['public', 'analytics'],
  operationId: 'public.analytics.events.create',
  auth: 'public',
  request: { body: analyticsEventBodySchema },
  responses: {
    202: { description: 'Accepted' },
    400: { description: 'Validation failed or personal data detected' },
    403: { description: 'Consent not granted' },
    429: { description: 'Rate limited' },
  },
});
