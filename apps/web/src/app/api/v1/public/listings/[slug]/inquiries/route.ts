import { createHash } from 'node:crypto';
import { z } from 'zod';
import { listingInquirySchema, slugSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { createListingInquiry } from '@/server/listings/inquiries';
import '@/lib/api/registry/listings';

export const dynamic = 'force-dynamic';

const HOUR = 3600;

/**
 * POST /api/v1/public/listings/:slug/inquiries. Same abuse limits as the
 * consultation form (5/hour per hashed IP, 3/hour per email); the honeypot
 * and too-fast heuristics mark the lead for review without telling the
 * visitor. The lead carries the listing reference for CRM qualification.
 */
export const POST = route<{ params: Promise<{ slug: string }> }>(async (req, ctx) => {
  const { slug } = await params(ctx, z.object({ slug: slugSchema }));
  const input = await parseJson(req, listingInquirySchema);
  const ipHash = hashIp(clientIp(req));
  await enforceRateLimit(`listing-inquiry:ip:${ipHash}`, { windowSeconds: HOUR, max: 5 });
  const emailHash = createHash('sha256').update(input.email.toLowerCase()).digest('hex').slice(0, 24);
  await enforceRateLimit(`listing-inquiry:email:${emailHash}`, { windowSeconds: HOUR, max: 3 });
  const identity = await getIdentity();
  const result = await createListingInquiry(slug, input, identity.session ? identity : null, {
    ipHash,
    userAgent: req.headers.get('user-agent'),
    correlationId: ctx.correlationId,
  });
  return json(result, { status: 201, correlationId: ctx.correlationId });
});
