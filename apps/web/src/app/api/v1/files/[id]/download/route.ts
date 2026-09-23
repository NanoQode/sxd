import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, correlationIdHeader, fileDownloadQuerySchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseQuery, route } from '@/lib/api/respond';
import { getIdentity } from '@/lib/auth/session';
import { clientIp, hashIp } from '@/lib/rate-limit';
import { issueDownload } from '@/server/files/download';
import '@/lib/api/registry/files';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/files/:id/download[?variant=thumb|web&expiresIn=&disposition=]
 * Redirects (302) to a short-lived signed URL on the storage host. Clients
 * that send `Accept: application/json` receive the URL in the body instead.
 */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const query = parseQuery(req, fileDownloadQuerySchema);
  const result = await issueDownload(identity, id, query, {
    correlationId: ctx.correlationId,
    ipHash: hashIp(clientIp(req)),
  });
  if ((req.headers.get('accept') ?? '').includes('application/json')) {
    return json(result, { correlationId: ctx.correlationId });
  }
  const res = NextResponse.redirect(result.url, 302);
  res.headers.set('cache-control', 'private, no-store');
  res.headers.set(correlationIdHeader, ctx.correlationId);
  return res;
});
