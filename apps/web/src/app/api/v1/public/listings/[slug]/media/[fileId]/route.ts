import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  correlationIdHeader,
  publicListingMediaQuerySchema,
  slugSchema,
  uuidSchema,
} from '@simplexd/contracts';
import { json, params, parseQuery, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { issuePublicListingMedia } from '@/server/listings/media';
import '@/lib/api/registry/listings';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/public/listings/:slug/media/:fileId[?variant=web|thumb]
 * Redirects to a short-lived signed URL of a publicly approved derivative of
 * a live listing's photo. Originals are never served; anything not approved,
 * not clean or not on the published revision is a 404.
 */
export const GET = route<{ params: Promise<{ slug: string; fileId: string }> }>(
  async (req, ctx) => {
    const { slug, fileId } = await params(ctx, z.object({ slug: slugSchema, fileId: uuidSchema }));
    const query = parseQuery(req, publicListingMediaQuerySchema);
    await enforceRateLimit(`listing-media:ip:${hashIp(clientIp(req))}`, {
      windowSeconds: 60,
      max: 120,
    });
    const result = await issuePublicListingMedia(slug, fileId, query.variant);
    if ((req.headers.get('accept') ?? '').includes('application/json')) {
      return json(result, { correlationId: ctx.correlationId });
    }
    const res = NextResponse.redirect(result.url, 302);
    res.headers.set('cache-control', 'private, no-store');
    res.headers.set(correlationIdHeader, ctx.correlationId);
    return res;
  },
);
