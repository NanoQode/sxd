import { createHash } from 'node:crypto';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { publicConsultationBodySchema } from '@/lib/api/registry/public';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { createLead } from '@/server/leads/create';

export const dynamic = 'force-dynamic';

const HOUR = 3600;

/**
 * Public consultation request. Validates the shared contract, applies abuse
 * limits (5/hour per hashed IP, 3/hour per email) and stores the lead with
 * the visitor's selected scenario, markets and budget. The honeypot and
 * too-fast heuristics are applied inside createLead and never surfaced.
 */
export const POST = route(async (req, { correlationId }) => {
  const { source, ...input } = await parseJson(req, publicConsultationBodySchema);
  const ipHash = hashIp(clientIp(req));
  await enforceRateLimit(`lead:ip:${ipHash}`, { windowSeconds: HOUR, max: 5 });
  const emailHash = createHash('sha256').update(input.email.toLowerCase()).digest('hex').slice(0, 24);
  await enforceRateLimit(`lead:email:${emailHash}`, { windowSeconds: HOUR, max: 3 });

  const identity = await getIdentity();
  const resolvedSource = input.scenarioId && source === 'website_form' ? 'map_scenario' : source;
  const lead = await createLead(input, identity.session ? identity : null, {
    source: resolvedSource,
    ipHash,
    userAgent: req.headers.get('user-agent'),
    correlationId,
  });
  return json({ id: lead.id, status: 'received' as const }, { status: 201, correlationId });
});
