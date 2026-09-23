import { z } from 'zod';
import { ApiError, slugSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { createLead } from '@/server/leads/create';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  serviceSlug: slugSchema,
  message: z.string().trim().max(4000).optional(),
  marketId: uuidSchema.nullable().optional(),
  scenarioId: uuidSchema.nullable().optional(),
  budgetNaira: z.number().positive().max(1e13).nullable().optional(),
});

/**
 * POST /api/v1/service-requests/interest — registers interest in a service that
 * is not bookable yet (expansion or unstaffed). Creates a lead with source
 * quote_request instead of a service request; operations follow up.
 */
export const POST = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  await enforceRateLimit(`service-requests:interest:${identity.session.user.id}`, { windowSeconds: 3600, max: 10 });
  const body = await parseJson(req, bodySchema);
  const lead = await createLead(
    {
      contactName: identity.session.user.name,
      email: identity.session.user.email,
      phoneE164: identity.profile?.phoneE164 ?? null,
      countryOfResidence: identity.profile?.countryOfResidence ?? null,
      timeZone: identity.profile?.timeZone ?? null,
      goal: 'other',
      serviceSlug: body.serviceSlug,
      message: body.message ?? null,
      scenarioId: body.scenarioId ?? null,
      marketIds: body.marketId ? [body.marketId] : [],
      budgetNaira: body.budgetNaira ?? null,
      marketingConsent: false,
      consentPolicyVersion: '2026-09',
    },
    identity,
    {
      source: 'quote_request',
      ipHash: hashIp(clientIp(req)),
      userAgent: req.headers.get('user-agent'),
      correlationId,
    },
  );
  return json({ leadId: lead.id, status: lead.status }, { status: 201, correlationId });
});
